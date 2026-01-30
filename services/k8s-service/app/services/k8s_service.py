"""
Kubernetes 클러스터 서비스
"""
from kubernetes import client, config
from kubernetes.client.rest import ApiException
from typing import List, Optional, Dict
from datetime import datetime
import os
import asyncio
from app.config import settings
from app.redis_cache import redis_cache
from app.cluster import (
    NamespaceInfo,
    ServiceInfo,
    DeploymentInfo,
    PodInfo,
    PVCInfo,
    PVInfo,
    ClusterOverview
)


class K8sService:
    """Kubernetes 클러스터 서비스"""
    
    def __init__(self):
        """K8s 클라이언트 초기화"""
        try:
            if settings.IN_CLUSTER:
                config.load_incluster_config()
            elif settings.KUBECONFIG_PATH and os.path.exists(settings.KUBECONFIG_PATH):
                config.load_kube_config(config_file=settings.KUBECONFIG_PATH)
            else:
                config.load_kube_config()
            
            # 연결 풀 크기 증설 (200명 동시 접속 대응)
            # 기본 설정 복사 및 수정
            c = client.Configuration.get_default_copy()
            c.client_side_validation = False
            
            # ApiClient 생성 시 pool_maxsize 설정
            api_client = client.ApiClient(configuration=c)
            if hasattr(api_client, 'rest_client') and hasattr(api_client.rest_client, 'pool_manager'):
                 api_client.rest_client.pool_manager.connection_pool_kw['maxsize'] = 200
            
            self.v1 = client.CoreV1Api(api_client=api_client)
            self.apps_v1 = client.AppsV1Api(api_client=api_client)
            self.version_api = client.VersionApi(api_client=api_client)
            
        except Exception as e:
            print(f"Warning: Kubernetes client initialization failed: {e}")
            self.v1 = None
            self.apps_v1 = None
            
    def get_fresh_core_v1_api(self):
        """로그 스트리밍용 독립 CoreV1Api 클라이언트 생성 (연결 풀 고갈 방지)"""
        try:
            # 설정 로드
            c = client.Configuration.get_default_copy()
            c.client_side_validation = False
            
            # 새 ApiClient 생성 (새로운 연결 풀 할당)
            new_api_client = client.ApiClient(configuration=c)
            return client.CoreV1Api(api_client=new_api_client)
        except Exception as e:
            print(f"Error creating fresh CoreV1Api: {e}")
            return self.v1  # 실패 시 기존 클라이언트 반환 (Fallback)
    
    async def get_cluster_overview(self, force_refresh: bool = False) -> ClusterOverview:
        """클러스터 전체 개요 (Redis 캐시)"""
        try:
            cache_key = "k8s:cluster_overview"
            
            # force_refresh이면 캐시 삭제
            if force_refresh:
                redis_cache.delete(cache_key)
                print(f"🗑️  Cache DELETED: {cache_key}")
            else:
                # 캐시 확인
                cached = redis_cache.get(cache_key)
                if cached:
                    print(f"✅ Cache HIT: {cache_key}")
                    return ClusterOverview(**cached)
            
            print(f"🔄 Cache MISS: {cache_key}, fetching from K8s API...")
            
            namespaces = self.v1.list_namespace()
            pods = self.v1.list_pod_for_all_namespaces()
            services = self.v1.list_service_for_all_namespaces()
            deployments = self.apps_v1.list_deployment_for_all_namespaces()
            pvcs = self.v1.list_persistent_volume_claim_for_all_namespaces()
            pvs = self.v1.list_persistent_volume()
            nodes = self.v1.list_node()
            
            # Pod 상태 집계
            pod_status = {}
            for pod in pods.items:
                status = pod.status.phase
                pod_status[status] = pod_status.get(status, 0) + 1
            
            # 클러스터 버전
            version_info = self.version_api.get_code()
            
            result = ClusterOverview(
                total_namespaces=len(namespaces.items),
                total_pods=len(pods.items),
                total_services=len(services.items),
                total_deployments=len(deployments.items),
                total_pvcs=len(pvcs.items),
                total_pvs=len(pvs.items),
                pod_status=pod_status,
                node_count=len(nodes.items),
                cluster_version=version_info.git_version
            )
            
            # Redis 캐시에 저장 (30초 TTL)
            redis_cache.set(cache_key, result.model_dump(), ttl=30)
            
            return result
        except ApiException as e:
            raise Exception(f"Failed to get cluster overview: {e}")
    
    async def get_namespaces(self, force_refresh: bool = False) -> List[NamespaceInfo]:
        """네임스페이스 목록 (캐시 + 병렬 처리)"""
        try:
            cache_key = "k8s:namespaces"
            
            # force_refresh이면 캐시 삭제
            if force_refresh:
                redis_cache.delete(cache_key)
                print(f"🗑️  Cache DELETED: {cache_key}")
            else:
                # 캐시 확인
                cached = redis_cache.get(cache_key)
                if cached:
                    print(f"✅ Cache HIT: {cache_key}")
                    return [NamespaceInfo(**ns) for ns in cached]
            
            print(f"🔄 Cache MISS: {cache_key}, fetching from K8s API...")
            
            # 전체 네임스페이스 조회
            namespaces = self.v1.list_namespace()
            
            # 모든 네임스페이스의 리소스를 한 번에 조회 (병렬)
            all_pods = self.v1.list_pod_for_all_namespaces()
            all_services = self.v1.list_service_for_all_namespaces()
            all_deployments = self.apps_v1.list_deployment_for_all_namespaces()
            all_pvcs = self.v1.list_persistent_volume_claim_for_all_namespaces()
            
            # 네임스페이스별로 집계
            pod_counts = {}
            service_counts = {}
            deployment_counts = {}
            pvc_counts = {}
            
            for pod in all_pods.items:
                ns = pod.metadata.namespace
                pod_counts[ns] = pod_counts.get(ns, 0) + 1
            
            for svc in all_services.items:
                ns = svc.metadata.namespace
                service_counts[ns] = service_counts.get(ns, 0) + 1
            
            for deploy in all_deployments.items:
                ns = deploy.metadata.namespace
                deployment_counts[ns] = deployment_counts.get(ns, 0) + 1
            
            for pvc in all_pvcs.items:
                ns = pvc.metadata.namespace
                pvc_counts[ns] = pvc_counts.get(ns, 0) + 1
            
            result = []
            for ns in namespaces.items:
                ns_name = ns.metadata.name
                result.append(NamespaceInfo(
                    name=ns_name,
                    status=ns.status.phase,
                    created_at=ns.metadata.creation_timestamp,
                    labels=ns.metadata.labels or {},
                    resource_count={
                        "pods": pod_counts.get(ns_name, 0),
                        "services": service_counts.get(ns_name, 0),
                        "deployments": deployment_counts.get(ns_name, 0),
                        "pvcs": pvc_counts.get(ns_name, 0)
                    }
                ))
            
            # Redis 캐시에 저장 (30초 TTL)
            redis_cache.set(cache_key, [ns.model_dump() for ns in result], ttl=30)
            
            return result
        except ApiException as e:
            raise Exception(f"Failed to get namespaces: {e}")
    
    async def get_services(self, namespace: str) -> List[ServiceInfo]:
        """서비스 목록"""
        try:
            services = self.v1.list_namespaced_service(namespace)
            result = []
            
            for svc in services.items:
                ports = []
                if svc.spec.ports:
                    for port in svc.spec.ports:
                        ports.append({
                            "name": port.name,
                            "port": port.port,
                            "target_port": str(port.target_port),
                            "protocol": port.protocol
                        })
                
                external_ip = None
                if svc.status.load_balancer and svc.status.load_balancer.ingress:
                    external_ip = svc.status.load_balancer.ingress[0].ip
                
                result.append(ServiceInfo(
                    name=svc.metadata.name,
                    namespace=svc.metadata.namespace,
                    type=svc.spec.type,
                    cluster_ip=svc.spec.cluster_ip,
                    external_ip=external_ip,
                    ports=ports,
                    selector=svc.spec.selector or {},
                    created_at=svc.metadata.creation_timestamp
                ))
            
            return result
        except ApiException as e:
            raise Exception(f"Failed to get services: {e}")
    
    async def get_deployments(self, namespace: str) -> List[DeploymentInfo]:
        """디플로이먼트 목록"""
        try:
            deployments = self.apps_v1.list_namespaced_deployment(namespace)
            result = []
            
            for deploy in deployments.items:
                # 첫 번째 컨테이너의 이미지
                image = deploy.spec.template.spec.containers[0].image if deploy.spec.template.spec.containers else ""
                
                # 상태 판단
                status = "Healthy"
                if deploy.status.ready_replicas != deploy.spec.replicas:
                    status = "Degraded"
                if deploy.status.ready_replicas == 0:
                    status = "Unavailable"
                
                result.append(DeploymentInfo(
                    name=deploy.metadata.name,
                    namespace=deploy.metadata.namespace,
                    replicas=deploy.spec.replicas or 0,
                    ready_replicas=deploy.status.ready_replicas or 0,
                    available_replicas=deploy.status.available_replicas or 0,
                    updated_replicas=deploy.status.updated_replicas or 0,
                    image=image,
                    labels=deploy.metadata.labels or {},
                    selector=deploy.spec.selector.match_labels or {},
                    created_at=deploy.metadata.creation_timestamp,
                    status=status
                ))
            
            return result
        except ApiException as e:
            raise Exception(f"Failed to get deployments: {e}")
    
    async def get_all_pods(self, force_refresh: bool = False) -> List[PodInfo]:
        """모든 네임스페이스의 파드 목록 조회"""
        try:
            print(f"[DEBUG] get_all_pods called with force_refresh={force_refresh}")
            pods = self.v1.list_pod_for_all_namespaces()
            result = []
            
            for pod in pods.items:
                containers = []
                restart_count = 0
                
                # 컨테이너 스펙에서 limits/requests 추출
                container_specs = {}
                if pod.spec.containers:
                    for spec in pod.spec.containers:
                        limits = None
                        requests = None
                        if spec.resources:
                            if spec.resources.limits:
                                # Quantity 객체를 문자열로 변환
                                limits = {k: str(v) for k, v in spec.resources.limits.items()}
                                print(f"[DEBUG] Pod {pod.metadata.name}, Container {spec.name}, Limits: {limits}")
                            if spec.resources.requests:
                                requests = {k: str(v) for k, v in spec.resources.requests.items()}
                                print(f"[DEBUG] Pod {pod.metadata.name}, Container {spec.name}, Requests: {requests}")
                        container_specs[spec.name] = {
                            "limits": limits,
                            "requests": requests
                        }
                
                if pod.status.container_statuses:
                    for container in pod.status.container_statuses:
                        container_info = {
                            "name": container.name,
                            "image": container.image,
                            "ready": container.ready,
                            "restart_count": container.restart_count,
                            "limits": None,
                            "requests": None
                        }
                        # limits/requests 추가
                        if container.name in container_specs:
                            container_info["limits"] = container_specs[container.name].get("limits")
                            container_info["requests"] = container_specs[container.name].get("requests")
                        containers.append(container_info)
                        restart_count += container.restart_count
                
                # Ready 상태
                ready_containers = sum(1 for c in containers if c["ready"])
                ready = f"{ready_containers}/{len(containers)}"
                
                if "kagent-controller" in pod.metadata.name:
                    print(f"[DEBUG GET_ALL_PODS] Final containers for {pod.metadata.name}: {containers}")
                
                result.append(PodInfo(
                    name=pod.metadata.name,
                    namespace=pod.metadata.namespace,
                    status=pod.status.phase,
                    phase=pod.status.phase,
                    node_name=pod.spec.node_name,
                    pod_ip=pod.status.pod_ip,
                    containers=containers,
                    labels=pod.metadata.labels or {},
                    created_at=pod.metadata.creation_timestamp,
                    restart_count=restart_count,
                    ready=ready
                ))
            
            print(f"[DEBUG GET_ALL_PODS] Returning {len(result)} pods")
            return result
        except ApiException as e:
            raise Exception(f"Failed to get all pods: {e}")
    
    async def get_pods(self, namespace: str, label_selector: Optional[str] = None, force_refresh: bool = False) -> List[PodInfo]:
        """파드 목록"""
        try:
            pods = self.v1.list_namespaced_pod(namespace, label_selector=label_selector)
            result = []
            
            for pod in pods.items:
                containers = []
                restart_count = 0
                
                # 컨테이너 스펙에서 limits/requests 추출
                container_specs = {}
                if pod.spec.containers:
                    for spec in pod.spec.containers:
                        limits = None
                        requests = None
                        if spec.resources:
                            if spec.resources.limits:
                                # Quantity 객체를 문자열로 변환
                                limits = {k: str(v) for k, v in spec.resources.limits.items()}
                                print(f"[DEBUG] Pod {pod.metadata.name}, Container {spec.name}, Limits: {limits}")
                            if spec.resources.requests:
                                requests = {k: str(v) for k, v in spec.resources.requests.items()}
                                print(f"[DEBUG] Pod {pod.metadata.name}, Container {spec.name}, Requests: {requests}")
                        container_specs[spec.name] = {
                            "limits": limits,
                            "requests": requests
                        }
                
                if pod.status.container_statuses:
                    for container in pod.status.container_statuses:
                        container_info = {
                            "name": container.name,
                            "image": container.image,
                            "ready": container.ready,
                            "restart_count": container.restart_count,
                            "limits": None,
                            "requests": None
                        }
                        # limits/requests 추가
                        if container.name in container_specs:
                            container_info["limits"] = container_specs[container.name].get("limits")
                            container_info["requests"] = container_specs[container.name].get("requests")
                        containers.append(container_info)
                        restart_count += container.restart_count
                
                # Ready 상태
                ready_containers = sum(1 for c in containers if c["ready"])
                ready = f"{ready_containers}/{len(containers)}"
                
                result.append(PodInfo(
                    name=pod.metadata.name,
                    namespace=pod.metadata.namespace,
                    status=pod.status.phase,
                    phase=pod.status.phase,
                    node_name=pod.spec.node_name,
                    pod_ip=pod.status.pod_ip,
                    containers=containers,
                    labels=pod.metadata.labels or {},
                    created_at=pod.metadata.creation_timestamp,
                    restart_count=restart_count,
                    ready=ready
                ))
            
            return result
        except ApiException as e:
            raise Exception(f"Failed to get pods: {e}")
    
    async def get_pod_logs(
        self,
        namespace: str,
        pod_name: str,
        container: Optional[str] = None,
        tail_lines: int = 100
    ) -> str:
        """파드 로그"""
        try:
            logs = self.v1.read_namespaced_pod_log(
                name=pod_name,
                namespace=namespace,
                container=container,
                tail_lines=tail_lines
            )
            return logs
        except ApiException as e:
            raise Exception(f"Failed to get pod logs: {e}")
    
    async def get_pvcs(self, namespace: Optional[str] = None, force_refresh: bool = False) -> List[PVCInfo]:
        """PVC 목록"""
        try:
            if namespace:
                pvcs = self.v1.list_namespaced_persistent_volume_claim(namespace)
            else:
                pvcs = self.v1.list_persistent_volume_claim_for_all_namespaces()
            
            result = []
            for pvc in pvcs.items:
                capacity = None
                if pvc.status.capacity:
                    capacity = pvc.status.capacity.get("storage")
                
                result.append(PVCInfo(
                    name=pvc.metadata.name,
                    namespace=pvc.metadata.namespace,
                    status=pvc.status.phase,
                    volume_name=pvc.spec.volume_name,
                    storage_class=pvc.spec.storage_class_name,
                    capacity=capacity,
                    access_modes=pvc.spec.access_modes or [],
                    created_at=pvc.metadata.creation_timestamp
                ))
            
            return result
        except ApiException as e:
            raise Exception(f"Failed to get PVCs: {e}")
    
    async def get_pvs(self) -> List[PVInfo]:
        """PV 목록"""
        try:
            pvs = self.v1.list_persistent_volume()
            result = []
            
            for pv in pvs.items:
                claim_ref = None
                if pv.spec.claim_ref:
                    claim_ref = {
                        "namespace": pv.spec.claim_ref.namespace,
                        "name": pv.spec.claim_ref.name
                    }
                
                result.append(PVInfo(
                    name=pv.metadata.name,
                    status=pv.status.phase,
                    capacity=pv.spec.capacity.get("storage"),
                    access_modes=pv.spec.access_modes or [],
                    storage_class=pv.spec.storage_class_name,
                    reclaim_policy=pv.spec.persistent_volume_reclaim_policy,
                    claim_ref=claim_ref,
                    created_at=pv.metadata.creation_timestamp
                ))
            
            return result
        except ApiException as e:
            raise Exception(f"Failed to get PVs: {e}")
    
    async def get_events(self, namespace: str, resource_name: Optional[str] = None) -> List[Dict]:
        """이벤트 조회"""
        try:
            events = self.v1.list_namespaced_event(namespace)
            result = []
            
            for event in events.items:
                if resource_name and event.involved_object.name != resource_name:
                    continue
                
                result.append({
                    "type": event.type,
                    "reason": event.reason,
                    "message": event.message,
                    "object": {
                        "kind": event.involved_object.kind,
                        "name": event.involved_object.name
                    },
                    "first_timestamp": event.first_timestamp,
                    "last_timestamp": event.last_timestamp,
                    "count": event.count
                })
            
            return result
        except ApiException as e:
            raise Exception(f"Failed to get events: {e}")
    
    async def get_deployment_yaml(self, namespace: str, name: str) -> str:
        """Deployment YAML 조회"""
        try:
            import yaml
            deployment = self.apps_v1.read_namespaced_deployment(name, namespace)
            
            # API 객체를 딕셔너리로 변환
            deployment_dict = client.ApiClient().sanitize_for_serialization(deployment)
            
            # managedFields 제거 (너무 길어서)
            if 'metadata' in deployment_dict and 'managedFields' in deployment_dict['metadata']:
                del deployment_dict['metadata']['managedFields']
            
            return yaml.dump(deployment_dict, default_flow_style=False, allow_unicode=True)
        except ApiException as e:
            raise Exception(f"Failed to get deployment YAML: {e}")
    
    async def get_service_yaml(self, namespace: str, name: str) -> str:
        """Service YAML 조회"""
        try:
            import yaml
            service = self.v1.read_namespaced_service(name, namespace)
            
            # API 객체를 딕셔너리로 변환
            service_dict = client.ApiClient().sanitize_for_serialization(service)
            
            # managedFields 제거
            if 'metadata' in service_dict and 'managedFields' in service_dict['metadata']:
                del service_dict['metadata']['managedFields']
            
            return yaml.dump(service_dict, default_flow_style=False, allow_unicode=True)
        except ApiException as e:
            raise Exception(f"Failed to get service YAML: {e}")
    
    async def get_configmaps(self, namespace: str) -> List[Dict]:
        """ConfigMap 목록 조회"""
        try:
            configmaps = self.v1.list_namespaced_config_map(namespace)
            result = []
            for cm in configmaps.items:
                result.append({
                    "name": cm.metadata.name,
                    "data_count": len(cm.data) if cm.data else 0,
                    "created_at": str(cm.metadata.creation_timestamp)
                })
            return result
        except ApiException as e:
            raise Exception(f"Failed to get configmaps: {e}")
    
    async def get_configmap_yaml(self, namespace: str, name: str) -> str:
        """ConfigMap YAML 조회"""
        try:
            import yaml
            cm = self.v1.read_namespaced_config_map(name, namespace)
            cm_dict = client.ApiClient().sanitize_for_serialization(cm)
            if 'metadata' in cm_dict and 'managedFields' in cm_dict['metadata']:
                del cm_dict['metadata']['managedFields']
            return yaml.dump(cm_dict, default_flow_style=False, allow_unicode=True)
        except ApiException as e:
            raise Exception(f"Failed to get configmap YAML: {e}")
    
    async def get_secrets(self, namespace: str) -> List[Dict]:
        """Secret 목록 조회"""
        try:
            secrets = self.v1.list_namespaced_secret(namespace)
            result = []
            for secret in secrets.items:
                result.append({
                    "name": secret.metadata.name,
                    "type": secret.type,
                    "data_count": len(secret.data) if secret.data else 0,
                    "created_at": str(secret.metadata.creation_timestamp)
                })
            return result
        except ApiException as e:
            raise Exception(f"Failed to get secrets: {e}")
    
    async def get_secret_yaml(self, namespace: str, name: str) -> str:
        """Secret YAML 조회"""
        try:
            import yaml
            secret = self.v1.read_namespaced_secret(name, namespace)
            secret_dict = client.ApiClient().sanitize_for_serialization(secret)
            if 'metadata' in secret_dict and 'managedFields' in secret_dict['metadata']:
                del secret_dict['metadata']['managedFields']
            return yaml.dump(secret_dict, default_flow_style=False, allow_unicode=True)
        except ApiException as e:
            raise Exception(f"Failed to get secret YAML: {e}")
    
    async def get_statefulsets(self, namespace: str) -> List[Dict]:
        """StatefulSet 목록 조회"""
        try:
            statefulsets = self.apps_v1.list_namespaced_stateful_set(namespace)
            result = []
            for sts in statefulsets.items:
                result.append({
                    "name": sts.metadata.name,
                    "replicas": sts.spec.replicas,
                    "ready_replicas": sts.status.ready_replicas or 0,
                    "current_replicas": sts.status.current_replicas or 0
                })
            return result
        except ApiException as e:
            raise Exception(f"Failed to get statefulsets: {e}")
    
    async def get_statefulset_yaml(self, namespace: str, name: str) -> str:
        """StatefulSet YAML 조회"""
        try:
            import yaml
            sts = self.apps_v1.read_namespaced_stateful_set(name, namespace)
            sts_dict = client.ApiClient().sanitize_for_serialization(sts)
            if 'metadata' in sts_dict and 'managedFields' in sts_dict['metadata']:
                del sts_dict['metadata']['managedFields']
            return yaml.dump(sts_dict, default_flow_style=False, allow_unicode=True)
        except ApiException as e:
            raise Exception(f"Failed to get statefulset YAML: {e}")
    
    async def get_daemonsets(self, namespace: str) -> List[Dict]:
        """DaemonSet 목록 조회"""
        try:
            daemonsets = self.apps_v1.list_namespaced_daemon_set(namespace)
            result = []
            for ds in daemonsets.items:
                result.append({
                    "name": ds.metadata.name,
                    "desired": ds.status.desired_number_scheduled or 0,
                    "current": ds.status.current_number_scheduled or 0,
                    "ready": ds.status.number_ready or 0
                })
            return result
        except ApiException as e:
            raise Exception(f"Failed to get daemonsets: {e}")
    
    async def get_daemonset_yaml(self, namespace: str, name: str) -> str:
        """DaemonSet YAML 조회"""
        try:
            import yaml
            ds = self.apps_v1.read_namespaced_daemon_set(name, namespace)
            ds_dict = client.ApiClient().sanitize_for_serialization(ds)
            if 'metadata' in ds_dict and 'managedFields' in ds_dict['metadata']:
                del ds_dict['metadata']['managedFields']
            return yaml.dump(ds_dict, default_flow_style=False, allow_unicode=True)
        except ApiException as e:
            raise Exception(f"Failed to get daemonset YAML: {e}")
    
    async def get_ingresses(self, namespace: str) -> List[Dict]:
        """Ingress 목록 조회"""
        try:
            networking_v1 = client.NetworkingV1Api()
            ingresses = networking_v1.list_namespaced_ingress(namespace)
            result = []
            for ing in ingresses.items:
                hosts = []
                if ing.spec.rules:
                    hosts = [rule.host for rule in ing.spec.rules if rule.host]
                result.append({
                    "name": ing.metadata.name,
                    "hosts": hosts,
                    "class": ing.spec.ingress_class_name
                })
            return result
        except ApiException as e:
            raise Exception(f"Failed to get ingresses: {e}")
    
    async def get_ingress_yaml(self, namespace: str, name: str) -> str:
        """Ingress YAML 조회"""
        try:
            import yaml
            networking_v1 = client.NetworkingV1Api()
            ing = networking_v1.read_namespaced_ingress(name, namespace)
            ing_dict = client.ApiClient().sanitize_for_serialization(ing)
            if 'metadata' in ing_dict and 'managedFields' in ing_dict['metadata']:
                del ing_dict['metadata']['managedFields']
            return yaml.dump(ing_dict, default_flow_style=False, allow_unicode=True)
        except ApiException as e:
            raise Exception(f"Failed to get ingress YAML: {e}")
    
    async def get_jobs(self, namespace: str) -> List[Dict]:
        """Job 목록 조회"""
        try:
            batch_v1 = client.BatchV1Api()
            jobs = batch_v1.list_namespaced_job(namespace)
            result = []
            for job in jobs.items:
                result.append({
                    "name": job.metadata.name,
                    "completions": job.spec.completions,
                    "succeeded": job.status.succeeded or 0,
                    "failed": job.status.failed or 0
                })
            return result
        except ApiException as e:
            raise Exception(f"Failed to get jobs: {e}")
    
    async def get_job_yaml(self, namespace: str, name: str) -> str:
        """Job YAML 조회"""
        try:
            import yaml
            batch_v1 = client.BatchV1Api()
            job = batch_v1.read_namespaced_job(name, namespace)
            job_dict = client.ApiClient().sanitize_for_serialization(job)
            if 'metadata' in job_dict and 'managedFields' in job_dict['metadata']:
                del job_dict['metadata']['managedFields']
            return yaml.dump(job_dict, default_flow_style=False, allow_unicode=True)
        except ApiException as e:
            raise Exception(f"Failed to get job YAML: {e}")
    
    async def get_cronjobs(self, namespace: str) -> List[Dict]:
        """CronJob 목록 조회"""
        try:
            batch_v1 = client.BatchV1Api()
            cronjobs = batch_v1.list_namespaced_cron_job(namespace)
            result = []
            for cj in cronjobs.items:
                result.append({
                    "name": cj.metadata.name,
                    "schedule": cj.spec.schedule,
                    "suspend": cj.spec.suspend or False,
                    "last_schedule": str(cj.status.last_schedule_time) if cj.status.last_schedule_time else None
                })
            return result
        except ApiException as e:
            raise Exception(f"Failed to get cronjobs: {e}")
    
    async def get_cronjob_yaml(self, namespace: str, name: str) -> str:
        """CronJob YAML 조회"""
        try:
            import yaml
            batch_v1 = client.BatchV1Api()
            cj = batch_v1.read_namespaced_cron_job(name, namespace)
            cj_dict = client.ApiClient().sanitize_for_serialization(cj)
            if 'metadata' in cj_dict and 'managedFields' in cj_dict['metadata']:
                del cj_dict['metadata']['managedFields']
            return yaml.dump(cj_dict, default_flow_style=False, allow_unicode=True)
        except ApiException as e:
            raise Exception(f"Failed to get cronjob YAML: {e}")
    
    async def get_pod_yaml(self, namespace: str, name: str) -> str:
        """Pod YAML 조회"""
        try:
            import yaml
            pod = self.v1.read_namespaced_pod(name, namespace)
            pod_dict = client.ApiClient().sanitize_for_serialization(pod)
            if 'metadata' in pod_dict and 'managedFields' in pod_dict['metadata']:
                del pod_dict['metadata']['managedFields']
            return yaml.dump(pod_dict, default_flow_style=False, allow_unicode=True)
        except ApiException as e:
            raise Exception(f"Failed to get pod YAML: {e}")
    
    async def get_pvc_yaml(self, namespace: str, name: str) -> str:
        """PVC YAML 조회"""
        try:
            import yaml
            pvc = self.v1.read_namespaced_persistent_volume_claim(name, namespace)
            pvc_dict = client.ApiClient().sanitize_for_serialization(pvc)
            if 'metadata' in pvc_dict and 'managedFields' in pvc_dict['metadata']:
                del pvc_dict['metadata']['managedFields']
            return yaml.dump(pvc_dict, default_flow_style=False, allow_unicode=True)
        except ApiException as e:
            raise Exception(f"Failed to get pvc YAML: {e}")
    
    async def get_pv_yaml(self, name: str) -> str:
        """PV YAML 조회"""
        try:
            import yaml
            pv = self.v1.read_persistent_volume(name)
            pv_dict = client.ApiClient().sanitize_for_serialization(pv)
            if 'metadata' in pv_dict and 'managedFields' in pv_dict['metadata']:
                del pv_dict['metadata']['managedFields']
            return yaml.dump(pv_dict, default_flow_style=False, allow_unicode=True)
        except ApiException as e:
            raise Exception(f"Failed to get pv YAML: {e}")
    
    async def describe_pod(self, namespace: str, name: str) -> Dict:
        """Pod 상세 정보 조회 (kubectl describe pod와 유사)"""
        try:
            pod = self.v1.read_namespaced_pod(name, namespace)
            events = self.v1.list_namespaced_event(
                namespace=namespace,
                field_selector=f"involvedObject.name={name},involvedObject.kind=Pod"
            )
            
            # Pod 상세 정보 구성
            # Phase 가져오기 (status.phase 또는 status가 없을 수 있음)
            phase = None
            if hasattr(pod.status, 'phase') and pod.status.phase:
                phase = pod.status.phase
            elif hasattr(pod.status, 'phase'):
                phase = str(pod.status.phase) if pod.status.phase is not None else None
            
            # Created at 가져오기
            created_at = None
            if hasattr(pod.metadata, 'creation_timestamp') and pod.metadata.creation_timestamp:
                try:
                    if hasattr(pod.metadata.creation_timestamp, 'isoformat'):
                        created_at = pod.metadata.creation_timestamp.isoformat()
                    else:
                        created_at = str(pod.metadata.creation_timestamp)
                except Exception as e:
                    print(f"[WARN] Failed to format creation_timestamp: {e}")
                    created_at = str(pod.metadata.creation_timestamp)
            
            # Node 가져오기
            node = None
            if hasattr(pod.spec, 'node_name') and pod.spec.node_name:
                node = pod.spec.node_name
            
            describe_info = {
                "name": pod.metadata.name,
                "namespace": pod.metadata.namespace,
                "status": phase,
                "phase": phase,  # 프론트엔드에서 사용하는 필드
                "node": node,
                "pod_ip": pod.status.pod_ip if hasattr(pod.status, 'pod_ip') else None,
                "start_time": str(pod.status.start_time) if hasattr(pod.status, 'start_time') and pod.status.start_time else None,
                "created_at": created_at,  # 프론트엔드에서 사용하는 필드 (ISO 형식)
                "labels": pod.metadata.labels or {},
                "annotations": pod.metadata.annotations or {},
                "containers": [],
                "conditions": [],
                "events": []
            }
            
            # 디버깅용 로그
            print(f"[DEBUG] describe_pod - name: {pod.metadata.name}, phase: {phase}, created_at: {created_at}, node: {node}")
            print(f"[DEBUG] pod.status.phase type: {type(pod.status.phase) if hasattr(pod.status, 'phase') else 'N/A'}")
            print(f"[DEBUG] pod.metadata.creation_timestamp: {pod.metadata.creation_timestamp if hasattr(pod.metadata, 'creation_timestamp') else 'N/A'}")
            
            # 컨테이너 정보
            if pod.status.container_statuses:
                for container in pod.status.container_statuses:
                    container_info = {
                        "name": container.name,
                        "image": container.image,
                        "ready": container.ready,
                        "restart_count": container.restart_count,
                        "state": {}
                    }
                    
                    if container.state.running:
                        container_info["state"] = {"running": {"started_at": str(container.state.running.started_at)}}
                    elif container.state.waiting:
                        container_info["state"] = {"waiting": {"reason": container.state.waiting.reason, "message": container.state.waiting.message}}
                    elif container.state.terminated:
                        container_info["state"] = {"terminated": {"reason": container.state.terminated.reason, "exit_code": container.state.terminated.exit_code}}
                    
                    describe_info["containers"].append(container_info)
            
            # Conditions
            if pod.status.conditions:
                for condition in pod.status.conditions:
                    describe_info["conditions"].append({
                        "type": condition.type,
                        "status": condition.status,
                        "reason": condition.reason,
                        "message": condition.message,
                        "last_transition_time": str(condition.last_transition_time) if condition.last_transition_time else None
                    })
            
            # Events
            for event in events.items:
                describe_info["events"].append({
                    "type": event.type,
                    "reason": event.reason,
                    "message": event.message,
                    "count": event.count,
                    "first_timestamp": str(event.first_timestamp) if event.first_timestamp else None,
                    "last_timestamp": str(event.last_timestamp) if event.last_timestamp else None
                })
            
            return describe_info
        except ApiException as e:
            raise Exception(f"Failed to describe pod: {e}")
    
    async def describe_deployment(self, namespace: str, name: str) -> Dict:
        """Deployment 상세 정보 조회"""
        try:
            deployment = self.apps_v1.read_namespaced_deployment(name, namespace)
            events = self.v1.list_namespaced_event(
                namespace=namespace,
                field_selector=f"involvedObject.name={name},involvedObject.kind=Deployment"
            )
            
            describe_info = {
                "name": deployment.metadata.name,
                "namespace": deployment.metadata.namespace,
                "replicas": {
                    "desired": deployment.spec.replicas,
                    "current": deployment.status.replicas or 0,
                    "ready": deployment.status.ready_replicas or 0,
                    "available": deployment.status.available_replicas or 0,
                    "unavailable": deployment.status.unavailable_replicas or 0
                },
                "strategy": deployment.spec.strategy.type if deployment.spec.strategy else None,
                "labels": deployment.metadata.labels or {},
                "selector": deployment.spec.selector.match_labels or {},
                "conditions": [],
                "events": []
            }
            
            # Conditions
            if deployment.status.conditions:
                for condition in deployment.status.conditions:
                    describe_info["conditions"].append({
                        "type": condition.type,
                        "status": condition.status,
                        "reason": condition.reason,
                        "message": condition.message
                    })
            
            # Events
            for event in events.items:
                describe_info["events"].append({
                    "type": event.type,
                    "reason": event.reason,
                    "message": event.message,
                    "count": event.count
                })
            
            return describe_info
        except ApiException as e:
            raise Exception(f"Failed to describe deployment: {e}")
    
    async def describe_service(self, namespace: str, name: str) -> Dict:
        """Service 상세 정보 조회"""
        try:
            service = self.v1.read_namespaced_service(name, namespace)
            
            describe_info = {
                "name": service.metadata.name,
                "namespace": service.metadata.namespace,
                "type": service.spec.type,
                "cluster_ip": service.spec.cluster_ip,
                "external_ips": service.spec.external_i_ps or [],
                "ports": [],
                "selector": service.spec.selector or {},
                "labels": service.metadata.labels or {}
            }
            
            # Ports
            if service.spec.ports:
                for port in service.spec.ports:
                    describe_info["ports"].append({
                        "name": port.name,
                        "protocol": port.protocol,
                        "port": port.port,
                        "target_port": str(port.target_port),
                        "node_port": port.node_port
                    })
            
            # LoadBalancer 정보
            if service.spec.type == "LoadBalancer" and service.status.load_balancer:
                if service.status.load_balancer.ingress:
                    describe_info["load_balancer_ingress"] = [
                        {"ip": ing.ip, "hostname": ing.hostname}
                        for ing in service.status.load_balancer.ingress
                    ]
            
            return describe_info
        except ApiException as e:
            raise Exception(f"Failed to describe service: {e}")
    
    async def get_node_list(self, force_refresh: bool = False) -> List[Dict]:
        """노드 목록 조회"""
        try:
            nodes = self.v1.list_node()
            node_list = []
            
            for node in nodes.items:
                node_info = {
                    "name": node.metadata.name,
                    "status": "Ready" if any(c.type == "Ready" and c.status == "True" for c in node.status.conditions) else "NotReady",
                    "roles": [],
                    "age": str(datetime.now() - node.metadata.creation_timestamp.replace(tzinfo=None)),
                    "version": node.status.node_info.kubelet_version,
                    "internal_ip": None,
                    "external_ip": None
                }
                
                # Roles
                if node.metadata.labels:
                    for label, value in node.metadata.labels.items():
                        if "node-role.kubernetes.io/" in label:
                            role = label.split("/")[1]
                            if role:
                                node_info["roles"].append(role)
                
                # IP addresses
                if node.status.addresses:
                    for addr in node.status.addresses:
                        if addr.type == "InternalIP":
                            node_info["internal_ip"] = addr.address
                        elif addr.type == "ExternalIP":
                            node_info["external_ip"] = addr.address
                
                node_list.append(node_info)
            
            return node_list
        except ApiException as e:
            raise Exception(f"Failed to get node list: {e}")
    
    async def describe_node(self, name: str) -> Dict:
        """노드 상세 정보 조회"""
        try:
            node = self.v1.read_node(name)
            
            describe_info = {
                "name": node.metadata.name,
                "labels": node.metadata.labels or {},
                "annotations": node.metadata.annotations or {},
                "conditions": [],
                "addresses": [],
                "capacity": {},
                "allocatable": {},
                "system_info": {}
            }
            
            # Conditions
            if node.status.conditions:
                for condition in node.status.conditions:
                    describe_info["conditions"].append({
                        "type": condition.type,
                        "status": condition.status,
                        "reason": condition.reason,
                        "message": condition.message
                    })
            
            # Addresses
            if node.status.addresses:
                for addr in node.status.addresses:
                    describe_info["addresses"].append({
                        "type": addr.type,
                        "address": addr.address
                    })
            
            # Capacity & Allocatable
            if node.status.capacity:
                describe_info["capacity"] = dict(node.status.capacity)
            if node.status.allocatable:
                describe_info["allocatable"] = dict(node.status.allocatable)
            
            # System Info
            if node.status.node_info:
                info = node.status.node_info
                describe_info["system_info"] = {
                    "os_image": info.os_image,
                    "kernel_version": info.kernel_version,
                    "container_runtime": info.container_runtime_version,
                    "kubelet_version": info.kubelet_version,
                    "kube_proxy_version": info.kube_proxy_version
                }
            
            return describe_info
        except ApiException as e:
            raise Exception(f"Failed to describe node: {e}")
    
    async def get_pod_metrics(self, namespace: Optional[str] = None) -> List[Dict]:
        """Pod 리소스 사용량 조회 (kubectl top pods)"""
        import time
        
        max_retries = 3
        retry_delay = 0.5  # 0.5초
        
        for attempt in range(1, max_retries + 1):
            try:
                custom_api = client.CustomObjectsApi()
                
                if namespace:
                    # 특정 네임스페이스의 Pod 메트릭
                    print(f"[DEBUG] Fetching pod metrics for namespace: {namespace} (attempt {attempt}/{max_retries})")
                    metrics = custom_api.list_namespaced_custom_object(
                        group="metrics.k8s.io",
                        version="v1beta1",
                        namespace=namespace,
                        plural="pods",
                        _request_timeout=5  # 5초 타임아웃
                    )
                else:
                    # 전체 네임스페이스의 Pod 메트릭
                    print(f"[DEBUG] Fetching pod metrics for all namespaces (attempt {attempt}/{max_retries})")
                    metrics = custom_api.list_cluster_custom_object(
                        group="metrics.k8s.io",
                        version="v1beta1",
                        plural="pods",
                        _request_timeout=5  # 5초 타임아웃
                    )
                
                result = []
                for item in metrics.get("items", []):
                    pod_name = item["metadata"]["name"]
                    pod_namespace = item["metadata"]["namespace"]
                    
                    # 컨테이너별 리소스 합산
                    total_cpu = 0
                    total_memory = 0
                    
                    for container in item.get("containers", []):
                        usage = container.get("usage", {})
                        
                        # CPU (nanocores -> millicores)
                        cpu_str = usage.get("cpu", "0")
                        if cpu_str.endswith("n"):
                            total_cpu += int(cpu_str[:-1]) / 1_000_000
                        elif cpu_str.endswith("m"):
                            total_cpu += int(cpu_str[:-1])
                        else:
                            total_cpu += int(cpu_str) * 1000
                        
                        # Memory (bytes -> Mi)
                        memory_str = usage.get("memory", "0")
                        if memory_str.endswith("Ki"):
                            total_memory += int(memory_str[:-2]) / 1024
                        elif memory_str.endswith("Mi"):
                            total_memory += int(memory_str[:-2])
                        elif memory_str.endswith("Gi"):
                            total_memory += int(memory_str[:-2]) * 1024
                        else:
                            total_memory += int(memory_str) / (1024 * 1024)
                    
                    result.append({
                        "namespace": pod_namespace,
                        "name": pod_name,
                        "cpu": f"{int(total_cpu)}m",
                        "memory": f"{int(total_memory)}Mi"
                    })
                
                print(f"[DEBUG] Pod metrics result count: {len(result)}")
                
                # 전체 네임스페이스 조회 시 결과가 없으면(빈 배열) 에러로 처리
                # (K8s Metrics Server가 일시적으로 데이터를 못 가져오는 경우 등)
                if not namespace and not result:
                    print(f"[WARN] No pod metrics found for all namespaces. Treating as error to preserve stale data.")
                    raise Exception("No pod metrics found (empty list returned from K8s API)")

                return result
                
            except ApiException as e:
                print(f"[ERROR] Failed to get pod metrics (attempt {attempt}/{max_retries}): {e.status} - {e.reason}")
                if attempt < max_retries:
                    print(f"[INFO] Retrying in {retry_delay}s...")
                    await asyncio.sleep(retry_delay)
                    retry_delay *= 2  # 지수 백오프
                else:
                    print(f"[ERROR] All retries exhausted. Response body: {e.body}")
                    # 마지막 시도 실패 시 빈 배열 반환 (500 에러 대신)
                    print(f"[WARN] Failed to get pod metrics: {e.body}")
                    raise
            except Exception as e:
                print(f"[ERROR] Unexpected error in get_pod_metrics (attempt {attempt}/{max_retries}): {type(e).__name__} - {str(e)}")
                if attempt < max_retries:
                    print(f"[INFO] Retrying in {retry_delay}s...")
                    await asyncio.sleep(retry_delay)
                    retry_delay *= 2
                else:
                    import traceback
                    traceback.print_exc()
                    # 마지막 시도 실패 시 빈 배열 반환 (500 에러 대신)
                    print(f"[WARN] Unexpected error in get_pod_metrics: {str(e)}")
                    raise
        
        # 이 줄에 도달하지 않지만 타입 체커를 위해
        return []
    
    async def get_node_metrics(self) -> List[Dict]:
        """Node 리소스 사용량 조회 (kubectl top nodes)"""
        try:
            custom_api = client.CustomObjectsApi()
            
            # Node 메트릭 조회
            metrics = custom_api.list_cluster_custom_object(
                group="metrics.k8s.io",
                version="v1beta1",
                plural="nodes"
            )
            
            # Node 정보 조회 (용량 확인용)
            nodes = self.v1.list_node()
            node_capacity = {}
            for node in nodes.items:
                node_capacity[node.metadata.name] = {
                    "cpu": node.status.capacity.get("cpu", "0"),
                    "memory": node.status.capacity.get("memory", "0")
                }
            
            result = []
            for item in metrics.get("items", []):
                node_name = item["metadata"]["name"]
                usage = item.get("usage", {})
                
                # CPU (nanocores -> millicores)
                cpu_str = usage.get("cpu", "0")
                if cpu_str.endswith("n"):
                    cpu_value = int(cpu_str[:-1]) / 1_000_000
                elif cpu_str.endswith("m"):
                    cpu_value = int(cpu_str[:-1])
                else:
                    cpu_value = int(cpu_str) * 1000
                
                # Memory (bytes -> Mi)
                memory_str = usage.get("memory", "0")
                if memory_str.endswith("Ki"):
                    memory_value = int(memory_str[:-2]) / 1024
                elif memory_str.endswith("Mi"):
                    memory_value = int(memory_str[:-2])
                elif memory_str.endswith("Gi"):
                    memory_value = int(memory_str[:-2]) * 1024
                else:
                    memory_value = int(memory_str) / (1024 * 1024)
                
                # 용량 대비 사용률 계산
                capacity = node_capacity.get(node_name, {})
                cpu_capacity_str = capacity.get("cpu", "0")
                memory_capacity_str = capacity.get("memory", "0")
                
                # CPU 용량 (cores -> millicores)
                cpu_capacity = int(cpu_capacity_str) * 1000 if cpu_capacity_str.isdigit() else 0
                
                # Memory 용량 (Ki -> Mi)
                if memory_capacity_str.endswith("Ki"):
                    memory_capacity = int(memory_capacity_str[:-2]) / 1024
                else:
                    memory_capacity = 0
                
                cpu_percent = (cpu_value / cpu_capacity * 100) if cpu_capacity > 0 else 0
                memory_percent = (memory_value / memory_capacity * 100) if memory_capacity > 0 else 0
                
                result.append({
                    "name": node_name,
                    "cpu": f"{int(cpu_value)}m",
                    "cpu_percent": f"{int(cpu_percent)}%",
                    "memory": f"{int(memory_value)}Mi",
                    "memory_percent": f"{int(memory_percent)}%"
                })
            
            return result
        except ApiException as e:
            raise Exception(f"Failed to get node metrics: {e}")

    async def get_component_statuses(self) -> List[Dict]:
        """컴포넌트 상태 조회"""
        try:
            # Kubernetes 1.19+ 에서는 componentstatuses API가 deprecated 되었습니다
            # 대신 빈 배열을 반환합니다
            return []
        except Exception as e:
            raise Exception(f"Failed to get component statuses: {str(e)}")
