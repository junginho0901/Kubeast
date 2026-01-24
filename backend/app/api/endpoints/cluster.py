"""
Kubernetes 클러스터 리소스 API
"""
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from typing import List, Optional
from app.services.k8s_service import K8sService
from app.models.cluster import (
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
MAX_CONNECTIONS_PER_POD = 2  # Pod당 최대 2개 연결 (초과 시 이전 연결 자동 종료)
MAX_TOTAL_CONNECTIONS = 20  # 전체 최대 연결 수


@router.get("/overview", response_model=ClusterOverview)
async def get_cluster_overview():
    """클러스터 전체 개요"""
    try:
        return await k8s_service.get_cluster_overview()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/namespaces", response_model=List[NamespaceInfo])
async def get_namespaces():
    """네임스페이스 목록 조회"""
    try:
        return await k8s_service.get_namespaces()
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
    label_selector: Optional[str] = Query(None, description="라벨 셀렉터 (예: app=nginx)")
):
    """특정 네임스페이스의 파드 목록"""
    try:
        return await k8s_service.get_pods(namespace, label_selector)
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
async def get_pvcs(namespace: Optional[str] = Query(None, description="네임스페이스 필터")):
    """PVC 목록 조회"""
    try:
        return await k8s_service.get_pvcs(namespace)
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
async def get_nodes():
    """노드 목록 조회"""
    try:
        nodes = await k8s_service.get_node_list()
        return nodes
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/pods/all")
async def get_all_pods():
    """전체 네임스페이스의 Pod 목록 조회"""
    try:
        pods = await k8s_service.get_all_pods()
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
    pod_key = f"{namespace}/{pod_name}"
    
    # 전체 연결 수 제한 체크
    total_connections = sum(len(conns) for conns in active_websocket_connections.values())
    if total_connections >= MAX_TOTAL_CONNECTIONS:
        await websocket.close(code=1008, reason="Server connection limit reached")
        return
    
    # 이전 연결 자동 종료 (새 연결 우선) - 백그라운드에서 비동기 처리
    if len(active_websocket_connections[pod_key]) >= MAX_CONNECTIONS_PER_POD:
        print(f"[WebSocket] Pod {pod_key}: Closing old connections (limit: {MAX_CONNECTIONS_PER_POD})")
        # 오래된 연결부터 종료 (FIFO) - 블로킹 방지를 위해 백그라운드 태스크로 처리
        while len(active_websocket_connections[pod_key]) >= MAX_CONNECTIONS_PER_POD:
            old_ws = active_websocket_connections[pod_key].pop(0)
            
            async def close_old_connection(ws, key):
                try:
                    await ws.close(code=1000, reason="New connection established")
                    print(f"[WebSocket] Closed old connection for {key}")
                except Exception as e:
                    print(f"[WebSocket] Error closing old connection: {e}")
            
            # 백그라운드에서 비동기 종료 (블로킹 방지)
            asyncio.create_task(close_old_connection(old_ws, pod_key))
    
    # 새 연결 수락
    await websocket.accept()
    active_websocket_connections[pod_key].append(websocket)
    print(f"[WebSocket] New connection for {pod_key} (total: {len(active_websocket_connections[pod_key])})")
    
    resp = None
    executor = None
    try:
        v1 = k8s_service.v1
        
        # 전용 ThreadPoolExecutor 생성 (리소스 격리)
        from concurrent.futures import ThreadPoolExecutor
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"log-{pod_name}")
        
        # Kubernetes API 호출
        resp = v1.read_namespaced_pod_log(
            name=pod_name,
            namespace=namespace,
            container=container,
            follow=True,
            tail_lines=tail_lines,
            _preload_content=False
        )
        
        # 비동기로 로그 읽기 및 전송
        loop = asyncio.get_event_loop()
        timeout_seconds = 60  # 1분 타임아웃 (리소스 절약)
        
        while True:
            try:
                # 타임아웃과 함께 읽기 (전용 executor 사용)
                chunk = await asyncio.wait_for(
                    loop.run_in_executor(executor, resp.read, 1024),
                    timeout=timeout_seconds
                )
                
                if not chunk:
                    break
                
                # WebSocket으로 전송 (타임아웃 추가)
                await asyncio.wait_for(
                    websocket.send_bytes(chunk),
                    timeout=5.0
                )
                
            except asyncio.TimeoutError:
                # 타임아웃 발생 시 연결 종료
                print(f"[WebSocket] Timeout for {pod_key}")
                break
            except WebSocketDisconnect:
                # 클라이언트 연결 끊김
                print(f"[WebSocket] Client disconnected: {pod_key}")
                break
            except Exception as e:
                # 에러 발생 시 전송 후 종료
                print(f"[WebSocket] Error streaming logs for {pod_key}: {e}")
                try:
                    await websocket.send_text(f"Error: {str(e)}")
                except:
                    pass
                break
        
    except WebSocketDisconnect:
        print(f"[WebSocket] Disconnected during setup: {pod_key}")
    except Exception as e:
        print(f"[WebSocket] Connection error for {pod_key}: {e}")
        try:
            await websocket.send_text(f"Connection Error: {str(e)}")
        except:
            pass
    finally:
        # 연결 추적에서 제거
        try:
            active_websocket_connections[pod_key].remove(websocket)
            if not active_websocket_connections[pod_key]:
                del active_websocket_connections[pod_key]
            print(f"[WebSocket] Removed connection for {pod_key}")
        except (ValueError, KeyError):
            pass
        
        # Kubernetes API 연결 정리
        if resp:
            try:
                resp.release_conn()
            except Exception as e:
                print(f"[WebSocket] Error releasing connection: {e}")
        
        # ThreadPoolExecutor 정리
        if executor:
            try:
                executor.shutdown(wait=False)
            except Exception as e:
                print(f"[WebSocket] Error shutting down executor: {e}")
        
        # WebSocket 종료
        try:
            await websocket.close()
        except:
            pass
