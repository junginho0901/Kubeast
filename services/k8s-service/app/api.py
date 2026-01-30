"""
Kubernetes 클러스터 리소스 API
"""
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from typing import List, Optional
from app.services.k8s_service import K8sService
from app.cluster import (
    NamespaceInfo,
    ServiceInfo,
    DeploymentInfo,
    PodInfo,
    PVCInfo,
    PVInfo,
    ClusterOverview
)
import asyncio
from collections import defaultdict

router = APIRouter()
k8s_service = K8sService()

# WebSocket 연결 추적 (Pod별 활성 연결 관리)
# Key: "namespace/pod_name", Value: list of WebSocket objects
active_websocket_connections = defaultdict(list)
# WebSocket별 Kubernetes API 스트림 추적 (강제 종료용)
# Key: id(websocket), Value: Kubernetes API response object
active_k8s_streams = {}
# 전역 연결 순서 추적 (오래된 연결 정리용)
# List of (websocket, pod_key)
global_connection_order = []

MAX_CONNECTIONS_PER_POD = 2  # Pod당 최대 2개 연결 (초과 시 이전 연결 자동 종료)
MAX_TOTAL_CONNECTIONS = 200  # 전체 최대 연결 수

# 이벤트 루프 상태 모니터링 (Heartbeat)
@router.on_event("startup")
async def startup_event():
    async def heartbeat():
        while True:
            await asyncio.sleep(5)
            print(f"[Heartbeat] Event loop is alive. Connections: {sum(len(c) for c in active_websocket_connections.values())}")
    asyncio.create_task(heartbeat())



@router.get("/overview", response_model=ClusterOverview)
async def get_cluster_overview(force_refresh: bool = Query(False, description="캐시 무시하고 강제 갱신")):
    """클러스터 전체 개요"""
    try:
        return await k8s_service.get_cluster_overview(force_refresh=force_refresh)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces", response_model=List[NamespaceInfo])
async def get_namespaces(force_refresh: bool = Query(False, description="캐시 무시하고 강제 갱신")):
    """네임스페이스 목록 조회"""
    try:
        return await k8s_service.get_namespaces(force_refresh=force_refresh)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/services", response_model=List[ServiceInfo])
async def get_services(namespace: str):
    """특정 네임스페이스의 서비스 목록"""
    try:
        return await k8s_service.get_services(namespace)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/deployments", response_model=List[DeploymentInfo])
async def get_deployments(namespace: str):
    """특정 네임스페이스의 디플로이먼트 목록"""
    try:
        return await k8s_service.get_deployments(namespace)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/pods", response_model=List[PodInfo])
async def get_pods(
    namespace: str,
    label_selector: Optional[str] = Query(None, description="라벨 셀렉터 (예: app=nginx)"),
    force_refresh: bool = Query(False, description="캐시 무시하고 강제 갱신")
):
    """특정 네임스페이스의 파드 목록"""
    try:
        return await k8s_service.get_pods(namespace, label_selector, force_refresh=force_refresh)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/pods/{pod_name}/logs")
async def get_pod_logs(
    namespace: str,
    pod_name: str,
    container: Optional[str] = Query(None, description="컨테이너 이름"),
    tail_lines: int = Query(100, description="마지막 N줄"),
    follow: bool = Query(False, description="실시간 스트리밍")
):
    """파드 로그 조회 (스트리밍 지원)"""
    try:
        if follow:
            # 실시간 스트리밍 모드 (ArgoCD 방식)
            async def log_stream():
                import urllib3
                from kubernetes.client.rest import ApiException
                import asyncio
                from concurrent.futures import ThreadPoolExecutor
                
                resp = None
                try:
                    v1 = k8s_service.v1
                    
                    # Kubernetes API를 직접 호출하여 스트리밍
                    resp = v1.read_namespaced_pod_log(
                        name=pod_name,
                        namespace=namespace,
                        container=container,
                        follow=True,
                        tail_lines=tail_lines,
                        _preload_content=False  # 스트리밍 활성화
                    )
                    
                    # 스트림에서 데이터 읽기 (비동기로 처리)
                    loop = asyncio.get_event_loop()
                    with ThreadPoolExecutor(max_workers=1) as executor:
                        while True:
                            try:
                                # 동기 read를 비동기로 실행 (타임아웃 추가)
                                chunk = await asyncio.wait_for(
                                    loop.run_in_executor(executor, resp.read, 1024),
                                    timeout=5.0
                                )
                                if not chunk:
                                    break
                                yield chunk
                            except asyncio.TimeoutError:
                                # 타임아웃 시 연결 체크 후 계속
                                continue
                            except asyncio.CancelledError:
                                # 클라이언트 연결 끊김
                                break
                    
                except ApiException as e:
                    error_msg = f"Kubernetes API Error: {e.status} - {e.reason}\n"
                    yield error_msg.encode('utf-8')
                except asyncio.CancelledError:
                    # 정상적인 취소
                    pass
                except Exception as e:
                    error_msg = f"Stream Error: {str(e)}\n"
                    yield error_msg.encode('utf-8')
                finally:
                    # 연결 정리
                    if resp:
                        try:
                            resp.release_conn()
                        except:
                            pass
            
            return StreamingResponse(
                log_stream(),
                media_type="text/plain",
                headers={
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no",
                    "Transfer-Encoding": "chunked"
                }
            )
        else:
            # 일반 모드
            logs = await k8s_service.get_pod_logs(namespace, pod_name, container, tail_lines)
            return {"logs": logs}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/pvcs", response_model=List[PVCInfo])
async def get_pvcs(
    namespace: Optional[str] = Query(None, description="네임스페이스 필터"),
    force_refresh: bool = Query(False)
):
    """PVC 목록 조회"""
    try:
        return await k8s_service.get_pvcs(namespace, force_refresh)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/pvs", response_model=List[PVInfo])
async def get_pvs():
    """PV 목록 조회"""
    try:
        return await k8s_service.get_pvs()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/events")
async def get_events(
    namespace: str,
    resource_name: Optional[str] = Query(None, description="리소스 이름 필터")
):
    """이벤트 조회"""
    try:
        events = await k8s_service.get_events(namespace, resource_name)
        return {"events": events}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/deployments/{name}/yaml")
async def get_deployment_yaml(namespace: str, name: str):
    """Deployment YAML 조회"""
    try:
        yaml_content = await k8s_service.get_deployment_yaml(namespace, name)
        return {"yaml": yaml_content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/services/{name}/yaml")
async def get_service_yaml(namespace: str, name: str):
    """Service YAML 조회"""
    try:
        yaml_content = await k8s_service.get_service_yaml(namespace, name)
        return {"yaml": yaml_content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ConfigMap
@router.get("/namespaces/{namespace}/configmaps")
async def get_configmaps(namespace: str):
    """ConfigMap 목록 조회"""
    try:
        configmaps = await k8s_service.get_configmaps(namespace)
        return configmaps
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/configmaps/{name}/yaml")
async def get_configmap_yaml(namespace: str, name: str):
    """ConfigMap YAML 조회"""
    try:
        yaml_content = await k8s_service.get_configmap_yaml(namespace, name)
        return {"yaml": yaml_content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Secret
@router.get("/namespaces/{namespace}/secrets")
async def get_secrets(namespace: str):
    """Secret 목록 조회"""
    try:
        secrets = await k8s_service.get_secrets(namespace)
        return secrets
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/secrets/{name}/yaml")
async def get_secret_yaml(namespace: str, name: str):
    """Secret YAML 조회"""
    try:
        yaml_content = await k8s_service.get_secret_yaml(namespace, name)
        return {"yaml": yaml_content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# StatefulSet
@router.get("/namespaces/{namespace}/statefulsets")
async def get_statefulsets(namespace: str):
    """StatefulSet 목록 조회"""
    try:
        statefulsets = await k8s_service.get_statefulsets(namespace)
        return statefulsets
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/statefulsets/{name}/yaml")
async def get_statefulset_yaml(namespace: str, name: str):
    """StatefulSet YAML 조회"""
    try:
        yaml_content = await k8s_service.get_statefulset_yaml(namespace, name)
        return {"yaml": yaml_content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# DaemonSet
@router.get("/namespaces/{namespace}/daemonsets")
async def get_daemonsets(namespace: str):
    """DaemonSet 목록 조회"""
    try:
        daemonsets = await k8s_service.get_daemonsets(namespace)
        return daemonsets
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/daemonsets/{name}/yaml")
async def get_daemonset_yaml(namespace: str, name: str):
    """DaemonSet YAML 조회"""
    try:
        yaml_content = await k8s_service.get_daemonset_yaml(namespace, name)
        return {"yaml": yaml_content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Ingress
@router.get("/namespaces/{namespace}/ingresses")
async def get_ingresses(namespace: str):
    """Ingress 목록 조회"""
    try:
        ingresses = await k8s_service.get_ingresses(namespace)
        return ingresses
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/ingresses/{name}/yaml")
async def get_ingress_yaml(namespace: str, name: str):
    """Ingress YAML 조회"""
    try:
        yaml_content = await k8s_service.get_ingress_yaml(namespace, name)
        return {"yaml": yaml_content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Job
@router.get("/namespaces/{namespace}/jobs")
async def get_jobs(namespace: str):
    """Job 목록 조회"""
    try:
        jobs = await k8s_service.get_jobs(namespace)
        return jobs
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/jobs/{name}/yaml")
async def get_job_yaml(namespace: str, name: str):
    """Job YAML 조회"""
    try:
        yaml_content = await k8s_service.get_job_yaml(namespace, name)
        return {"yaml": yaml_content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# CronJob
@router.get("/namespaces/{namespace}/cronjobs")
async def get_cronjobs(namespace: str):
    """CronJob 목록 조회"""
    try:
        cronjobs = await k8s_service.get_cronjobs(namespace)
        return cronjobs
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/cronjobs/{name}/yaml")
async def get_cronjob_yaml(namespace: str, name: str):
    """CronJob YAML 조회"""
    try:
        yaml_content = await k8s_service.get_cronjob_yaml(namespace, name)
        return {"yaml": yaml_content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Pod
@router.get("/namespaces/{namespace}/pods/{name}/yaml")
async def get_pod_yaml(namespace: str, name: str):
    """Pod YAML 조회"""
    try:
        yaml_content = await k8s_service.get_pod_yaml(namespace, name)
        return {"yaml": yaml_content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# PVC
@router.get("/namespaces/{namespace}/pvcs/{name}/yaml")
async def get_pvc_yaml(namespace: str, name: str):
    """PVC YAML 조회"""
    try:
        yaml_content = await k8s_service.get_pvc_yaml(namespace, name)
        return {"yaml": yaml_content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# PV
@router.get("/pvs/{name}/yaml")
async def get_pv_yaml(name: str):
    """PV YAML 조회"""
    try:
        yaml_content = await k8s_service.get_pv_yaml(name)
        return {"yaml": yaml_content}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 클러스터 뷰용 API
@router.get("/nodes")
async def get_nodes(force_refresh: bool = Query(False)):
    """노드 목록 조회"""
    try:
        nodes = await k8s_service.get_node_list(force_refresh)
        return nodes
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/pods/all")
async def get_all_pods(force_refresh: bool = Query(False)):
    """전체 네임스페이스의 Pod 목록 조회"""
    try:
        pods = await k8s_service.get_all_pods(force_refresh)
        return pods
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces/{namespace}/pods/{name}/describe")
async def describe_pod(namespace: str, name: str):
    """Pod 상세 정보 조회"""
    try:
        pod_detail = await k8s_service.describe_pod(namespace, name)
        return pod_detail
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.websocket("/namespaces/{namespace}/pods/{pod_name}/logs/ws")
async def websocket_pod_logs(
    websocket: WebSocket,
    namespace: str,
    pod_name: str,
    container: Optional[str] = Query(None),
    tail_lines: int = Query(100)
):
    """WebSocket을 통한 실시간 로그 스트리밍 (자동 이전 연결 종료)"""
    # Pod + Container 조합으로 키 생성 (같은 파드의 다른 컨테이너는 별도 추적)
    pod_key = f"{namespace}/{pod_name}/{container or 'default'}"
    
    # 전체 연결 수 제한 체크 및 오래된 연결 정리 (Global LRU)
    total_connections = sum(len(conns) for conns in active_websocket_connections.values())
    global_order_count = len(global_connection_order)
    
    print(f"[WebSocket] Checking limit - Total: {total_connections}, GlobalOrder: {global_order_count}, Max: {MAX_TOTAL_CONNECTIONS}")
    
    if total_connections >= MAX_TOTAL_CONNECTIONS:
        print(f"[WebSocket] Global limit reached ({total_connections}). Evicting oldest connection.")
        
        # 방어 코드: 순서 목록이 비어있으면 강제로 active_websocket_connections에서 찾음
        if not global_connection_order and total_connections > 0:
            print("[WebSocket] Warning: global_connection_order is empty but connections exist!")
            # 임의의 연결 찾아서 종료
            for key, conns in active_websocket_connections.items():
                if conns:
                    global_connection_order.append((conns[0], key))
                    break
        
        # 전역에서 가장 오래된 연결 찾아서 종료
        if global_connection_order:
            oldest_ws, oldest_key = global_connection_order.pop(0)
            ws_id = id(oldest_ws)
            
            try:
                # 1. Kubernetes API 스트림 정리 (강제 종료)
                old_resp = active_k8s_streams.pop(ws_id, None)
                if old_resp:
                    try:
                        # release_conn 대신 close 사용 (소켓 강제 종료로 read() 중단 유도)
                        old_resp.close()
                        print(f"[WebSocket] Closed K8s stream (socket) for old connection {oldest_key}")
                    except Exception as e:
                        print(f"[WebSocket] Error closing old K8s stream: {e}")
                
                # 2. WebSocket 종료
                try:
                    await asyncio.wait_for(
                        oldest_ws.close(code=1000, reason="Evicted by new connection"),
                        timeout=1.0
                    )
                except:
                    pass
                
                # 3. 연결 목록에서 제거
                if oldest_ws in active_websocket_connections[oldest_key]:
                    active_websocket_connections[oldest_key].remove(oldest_ws)
                    if not active_websocket_connections[oldest_key]:
                        del active_websocket_connections[oldest_key]
                
                print(f"[WebSocket] Evicted oldest connection for {oldest_key}")
            except Exception as e:
                print(f"[WebSocket] Error evicting connection: {e}")
    
    
    # 이전 연결 자동 종료 (새 연결 우선) - 동기적으로 처리하여 확실히 정리
    if len(active_websocket_connections[pod_key]) >= MAX_CONNECTIONS_PER_POD:
        print(f"[WebSocket] Pod {pod_key}: Closing old connections (limit: {MAX_CONNECTIONS_PER_POD})")
        # 오래된 연결부터 종료 (FIFO) - 동기적으로 기다려서 확실히 정리
        while len(active_websocket_connections[pod_key]) >= MAX_CONNECTIONS_PER_POD:
            old_ws = active_websocket_connections[pod_key].pop(0)
            ws_id = id(old_ws)
            
            try:
                # 1. Kubernetes API 스트림 먼저 종료 (중요!)
                old_resp = active_k8s_streams.pop(ws_id, None)
                if old_resp:
                    try:
                        # release_conn 대신 close 사용
                        old_resp.close()
                        print(f"[WebSocket] Closed K8s stream for old connection {pod_key}")
                    except Exception as e:
                        print(f"[WebSocket] Error closing old K8s stream: {e}")
                
                # 2. WebSocket 종료 (타임아웃 추가하여 블로킹 방지)
                try:
                    await asyncio.wait_for(
                        old_ws.close(code=1000, reason="New connection established"),
                        timeout=1.0
                    )
                    print(f"[WebSocket] Closed old WebSocket for {pod_key}")
                except asyncio.TimeoutError:
                    print(f"[WebSocket] Timeout closing old WebSocket for {pod_key}")
                except Exception as e:
                    print(f"[WebSocket] Error closing old WebSocket: {e}")
            except Exception as e:
                print(f"[WebSocket] Error cleaning up old connection: {e}")
    
    # 새 연결 수락
    await websocket.accept()
    active_websocket_connections[pod_key].append(websocket)
    global_connection_order.append((websocket, pod_key))  # 순서 추적 추가
    print(f"[WebSocket] New connection for {pod_key} (total: {len(active_websocket_connections[pod_key])})")
    
    
    # K8s API 설정 가져오기
    try:
        # 전역 v1 클라이언트 사용 (설정만 추출하므로 공유해도 안전)
        config = k8s_service.v1.api_client.configuration
        host = config.host
        verify_ssl = config.verify_ssl
        ssl_ca_cert = config.ssl_ca_cert
        
        # Auth Config 디버깅
        print(f"[WebSocket] Auth Debug - Host: {host}")
        print(f"[WebSocket] Auth Debug - API API Key present: {bool(config.api_key)}")
        print(f"[WebSocket] Auth Debug - Cert File: {config.cert_file}")
        print(f"[WebSocket] Auth Debug - Key File: {config.key_file}")
        
        # Token 추출
        # api_key는 {'authorization': 'Bearer ...'} 형태일 수 있음
        api_key_prefix = config.api_key_prefix.get('authorization', 'Bearer')
        api_key = config.api_key.get('authorization')
        
        headers = {}
        if api_key:
             headers['Authorization'] = f"{api_key_prefix} {api_key}"
        
        # SSL Context 설정
        import ssl
        ssl_context = None
        if verify_ssl:
            ssl_context = ssl.create_default_context(cafile=ssl_ca_cert)
        else:
            ssl_context = ssl.create_default_context()
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
            
        # Client Certificate 설정 (mTLS)
        if config.cert_file and config.key_file:
            print(f"[WebSocket] Loading client certs for mTLS: {config.cert_file}")
            ssl_context.load_cert_chain(certfile=config.cert_file, keyfile=config.key_file)
            
        # API Endpoint 구성
        path = f"/api/v1/namespaces/{namespace}/pods/{pod_name}/log"
        params = {
            "container": container,
            "follow": "true",
            "tailLines": str(tail_lines),
            "timestamps": "true"
        }
        
        url = f"{host}{path}"
        
        print(f"[WebSocket] Starting Async Stream via aiohttp for {pod_key}")
        
        # aiohttp로 비동기 스트리밍 (ThreadFree, QueueFree)
        import aiohttp
        
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params, headers=headers, ssl=ssl_context) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    print(f"[WebSocket] K8s API Error: {resp.status} - {error_text}")
                    await websocket.send_text(f"Error: K8s API returned {resp.status}")
                    return

                # 스트림 파이프라인 (Direct Copy)
                # K8s -> [aiohttp] -> [WebSocket]
                async for chunk in resp.content.iter_chunked(4096):
                    await websocket.send_bytes(chunk)
                    
    except asyncio.CancelledError:
        print(f"[WebSocket] Client disconnected (Cancelled): {pod_key}")
    except WebSocketDisconnect:
        print(f"[WebSocket] Client disconnected: {pod_key}")
    except Exception as e:
        print(f"[WebSocket] Async Stream Error for {pod_key}: {e}")
        try:
            await websocket.send_text(f"Error: {str(e)}")
        except:
            pass
    finally:
        print(f"[WebSocket] Stream finished: {pod_key}")
        
        # 연결 추적에서 제거 (Cleanup)
        try:
            active_websocket_connections[pod_key].remove(websocket)
            if not active_websocket_connections[pod_key]:
                del active_websocket_connections[pod_key]
                
            # 글로벌 순서에서 제거
            for i, (ws, pk) in enumerate(global_connection_order):
                if ws == websocket:
                    global_connection_order.pop(i)
                    break
                    
            print(f"[WebSocket] Removed connection for {pod_key}")
        except:
            pass
            
        # WebSocket 종료
        try:
            await websocket.close()
        except:
            pass


@router.get("/metrics/pods")
async def get_pod_metrics(namespace: Optional[str] = Query(None, description="특정 네임스페이스 필터")):
    """Pod 리소스 사용량 조회 (kubectl top pods)"""
    try:
        return await k8s_service.get_pod_metrics(namespace)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/metrics/nodes")
async def get_node_metrics():
    """Node 리소스 사용량 조회 (kubectl top nodes)"""
    try:
        return await k8s_service.get_node_metrics()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/metrics/top-resources")
async def get_top_resources(
    pod_limit: int = Query(5, description="상위 N개 파드"),
    node_limit: int = Query(3, description="상위 N개 노드")
):
    """리소스 사용량 Top N 파드/노드 조회"""
    try:
        # 파드 메트릭 가져오기
        pod_metrics = await k8s_service.get_pod_metrics()
        
        # 노드 메트릭 가져오기
        node_metrics = await k8s_service.get_node_metrics()
        
        # 파드 CPU 기준 정렬 (내림차순)
        def parse_cpu(cpu_str: str) -> float:
            """CPU 문자열을 숫자로 변환 (millicores)"""
            if cpu_str.endswith('m'):
                return float(cpu_str[:-1])
            elif cpu_str.endswith('n'):
                return float(cpu_str[:-1]) / 1_000_000
            else:
                return float(cpu_str) * 1000
        
        def parse_memory(mem_str: str) -> float:
            """Memory 문자열을 숫자로 변환 (Mi)"""
            if mem_str.endswith('Mi'):
                return float(mem_str[:-2])
            elif mem_str.endswith('Gi'):
                return float(mem_str[:-2]) * 1024
            elif mem_str.endswith('Ki'):
                return float(mem_str[:-2]) / 1024
            else:
                return float(mem_str) / (1024 * 1024)
        
        # 파드를 CPU+Memory 합계로 정렬 (가중치: CPU 70%, Memory 30%)
        for pod in pod_metrics:
            cpu_val = parse_cpu(pod.get('cpu', '0m'))
            mem_val = parse_memory(pod.get('memory', '0Mi'))
            # 정규화된 점수 (CPU는 1000m = 1 core 기준, Memory는 1000Mi = 1Gi 기준)
            pod['_score'] = (cpu_val / 1000 * 0.7) + (mem_val / 1000 * 0.3)
        
        top_pods = sorted(pod_metrics, key=lambda x: x.get('_score', 0), reverse=True)[:pod_limit]
        
        # _score 필드 제거
        for pod in top_pods:
            pod.pop('_score', None)
        
        # 노드를 CPU 사용률로 정렬
        def parse_percent(percent_str: str) -> float:
            """백분율 문자열을 숫자로 변환"""
            return float(percent_str.rstrip('%'))
        
        for node in node_metrics:
            cpu_percent = parse_percent(node.get('cpu_percent', '0%'))
            mem_percent = parse_percent(node.get('memory_percent', '0%'))
            node['_score'] = (cpu_percent * 0.7) + (mem_percent * 0.3)
        
        top_nodes = sorted(node_metrics, key=lambda x: x.get('_score', 0), reverse=True)[:node_limit]
        
        # _score 필드 제거
        for node in top_nodes:
            node.pop('_score', None)
        
        return {
            "top_pods": top_pods,
            "top_nodes": top_nodes
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/nodes/{name}/describe")
async def describe_node(name: str):
    """노드 상세 정보 조회"""
    try:
        node_detail = await k8s_service.describe_node(name)
        return node_detail
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/componentstatuses")
async def get_component_statuses():
    """컴포넌트 상태 조회"""
    try:
        statuses = await k8s_service.get_component_statuses()
        return statuses
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Topology endpoints
@router.get("/topology/namespace/{namespace}")
async def get_namespace_topology(namespace: str):
    """
    네임스페이스 전체 리소스 관계도
    - Service → Deployment → Pod
    - PVC → PV
    - ConfigMap, Secret 연결
    """
    try:
        from app.services.topology_service import TopologyService
        topology_service = TopologyService()
        return await topology_service.get_namespace_topology(namespace)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/topology/service/{namespace}/{service_name}")
async def get_service_topology(namespace: str, service_name: str):
    """특정 서비스의 리소스 관계도"""
    try:
        from app.services.topology_service import TopologyService
        topology_service = TopologyService()
        return await topology_service.get_service_topology(namespace, service_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/topology/deployment/{namespace}/{deployment_name}")
async def get_deployment_topology(namespace: str, deployment_name: str):
    """특정 디플로이먼트의 리소스 관계도"""
    try:
        from app.services.topology_service import TopologyService
        topology_service = TopologyService()
        return await topology_service.get_deployment_topology(namespace, deployment_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/topology/storage")
async def get_storage_topology():
    """스토리지 리소스 관계도 (PV, PVC)"""
    try:
        from app.services.topology_service import TopologyService
        topology_service = TopologyService()
        return await topology_service.get_storage_topology()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
