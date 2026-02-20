"""
Kubernetes 클러스터 서비스
"""
from kubernetes import client, config
from kubernetes.client.rest import ApiException
from typing import List, Optional, Dict, Any
from datetime import datetime
import os
import asyncio
import json
from app.config import settings
from app.redis_cache import redis_cache
from app.cluster import (
    NamespaceInfo,
    ServiceInfo,
    DeploymentInfo,
    ReplicaSetInfo,
    HPAInfo,
    PDBInfo,
    PodInfo,
    PVCInfo,
    PVInfo,
    ClusterOverview
)


METRICS_REQUEST_TIMEOUT = 6  # seconds for metrics.k8s.io calls
METRICS_MAX_RETRIES = 2      # max retries for metrics fetch


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

            self.api_client = api_client
            
            self.v1 = client.CoreV1Api(api_client=api_client)
            self.apps_v1 = client.AppsV1Api(api_client=api_client)
            self.version_api = client.VersionApi(api_client=api_client)
            # optional APIs
            try:
                self.autoscaling_v2 = client.AutoscalingV2Api(api_client=api_client)
            except Exception:
                self.autoscaling_v2 = None
            try:
                self.policy_v1 = client.PolicyV1Api(api_client=api_client)
            except Exception:
                self.policy_v1 = None

            # Discovery cache (api-resources)
            self._api_resources_cache: Optional[List[Dict[str, Any]]] = None
            self._api_resources_cache_at: float = 0.0
            
        except Exception as e:
            print(f"Warning: Kubernetes client initialization failed: {e}")
            self.v1 = None
            self.apps_v1 = None
            self.api_client = None
            self.autoscaling_v2 = None
            self.policy_v1 = None
            
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

    def _raw_get_json(self, path: str) -> Dict[str, Any]:
        """ApiClient를 통해 raw JSON 응답을 가져온다."""
        if self.api_client is None:
            raise Exception("Kubernetes client not initialized")
        if not path.startswith("/"):
            path = "/" + path
        # call_api는 인증 헤더를 포함해 호출한다.
        resp = self.api_client.call_api(
            path,
            "GET",
            response_type="str",
            auth_settings=["BearerToken"],
            _preload_content=False,
        )[0]
        data = resp.data if hasattr(resp, "data") else resp
        if isinstance(data, bytes):
            data = data.decode("utf-8")
        return json.loads(data)

    def _normalize_resource_key(self, value: str) -> str:
        return (value or "").strip().lower()

    def _get_default_namespace(self) -> str:
        sa_ns_path = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"

        # 1) In-cluster: service account namespace
        if getattr(settings, "IN_CLUSTER", False):
            try:
                if os.path.exists(sa_ns_path):
                    with open(sa_ns_path, "r", encoding="utf-8") as f:
                        ns = f.read().strip()
                        if ns:
                            return ns
            except Exception:
                pass

        # 2) Out-of-cluster: kubeconfig current-context namespace
        kubeconfig_path = ""
        if settings.KUBECONFIG_PATH and os.path.exists(settings.KUBECONFIG_PATH):
            kubeconfig_path = settings.KUBECONFIG_PATH
        else:
            default_path = os.path.expanduser("~/.kube/config")
            if os.path.exists(default_path):
                kubeconfig_path = default_path

        if kubeconfig_path:
            try:
                import yaml

                with open(kubeconfig_path, "r", encoding="utf-8") as f:
                    data = yaml.safe_load(f) or {}
                current = data.get("current-context")
                if current:
                    for ctx in data.get("contexts", []) or []:
                        if ctx.get("name") == current:
                            ns = (ctx.get("context") or {}).get("namespace")
                            if ns:
                                return ns
            except Exception:
                pass

        return "default"

    async def get_available_api_resources(self, force_refresh: bool = False) -> List[Dict[str, Any]]:
        """kubectl api-resources와 유사한 목록을 반환한다."""
        # 캐시 (60초)
        now = datetime.utcnow().timestamp()
        if self._api_resources_cache and not force_refresh and (now - self._api_resources_cache_at) < 60:
            return self._api_resources_cache

        resources: List[Dict[str, Any]] = []

        def add_resources(group_version: str, group: str, items: List[Dict[str, Any]]) -> None:
            for r in items or []:
                name = r.get("name", "")
                if not name or "/" in name:
                    # subresource는 제외
                    continue
                resources.append(
                    {
                        "name": name,
                        "singularName": r.get("singularName", ""),
                        "shortNames": r.get("shortNames", []) or [],
                        "kind": r.get("kind", ""),
                        "namespaced": bool(r.get("namespaced", False)),
                        "groupVersion": group_version,
                        "group": group,
                        "verbs": r.get("verbs", []) or [],
                    }
                )

        # Core API (/api/v1)
        core = self._raw_get_json("/api/v1")
        add_resources("v1", "", core.get("resources", []))

        # Aggregated APIs (/apis)
        apis = self._raw_get_json("/apis")
        for g in apis.get("groups", []) or []:
            group = g.get("name", "")
            for ver in g.get("versions", []) or []:
                gv = ver.get("groupVersion", "")
                if not gv:
                    continue
                gv_data = self._raw_get_json(f"/apis/{gv}")
                add_resources(gv, group, gv_data.get("resources", []))

        self._api_resources_cache = resources
        self._api_resources_cache_at = now
        return resources

    async def _resolve_api_resource(self, resource_type: str) -> Dict[str, Any]:
        key = self._normalize_resource_key(resource_type)
        if not key:
            raise Exception("resource_type is required")

        resources = await self.get_available_api_resources()

        # Handle "name.group" (e.g., deployments.apps)
        name_part = key
        group_part = ""
        if "." in key:
            name_part, group_part = key.split(".", 1)

        for r in resources:
            names = {self._normalize_resource_key(r.get("name", ""))}
            singular = self._normalize_resource_key(r.get("singularName", ""))
            if singular:
                names.add(singular)
            kind = self._normalize_resource_key(r.get("kind", ""))
            if kind:
                names.add(kind)
            for sn in r.get("shortNames", []) or []:
                names.add(self._normalize_resource_key(sn))

            if name_part in names:
                if group_part and self._normalize_resource_key(r.get("group", "")) != group_part:
                    continue
                return r

        raise Exception(f"Unknown resource_type: {resource_type}")

    def _build_resource_path(
        self,
        resource: Dict[str, Any],
        namespace: Optional[str],
        all_namespaces: bool,
    ) -> str:
        group_version = resource.get("groupVersion", "v1")
        base = f"/api/{group_version}" if group_version == "v1" else f"/apis/{group_version}"
        name = resource["name"]
        namespaced = bool(resource.get("namespaced", False))

        if namespaced and not all_namespaces:
            ns = namespace or self._get_default_namespace()
            return f"{base}/namespaces/{ns}/{name}"

        return f"{base}/{name}"

    async def get_resources(
        self,
        resource_type: str,
        resource_name: Optional[str] = None,
        namespace: Optional[str] = None,
        all_namespaces: bool = False,
        output: str = "wide",
    ) -> Dict[str, Any]:
        resource = await self._resolve_api_resource(resource_type)
        verbs = set(resource.get("verbs", []) or [])
        if resource_name and "get" not in verbs:
            raise Exception(f"Resource {resource_type} does not support get")
        if not resource_name and "list" not in verbs:
            raise Exception(f"Resource {resource_type} does not support list")

        path = self._build_resource_path(resource, namespace, all_namespaces)
        if resource_name:
            path = f"{path}/{resource_name}"

        data = self._raw_get_json(path)

        if output and output.lower() == "yaml":
            import yaml

            return {"format": "yaml", "data": yaml.dump(data, default_flow_style=False, allow_unicode=True)}

        return {"format": "json", "data": data}

    async def get_resource_yaml(
        self,
        resource_type: str,
        resource_name: str,
        namespace: Optional[str] = None,
    ) -> str:
        payload = await self.get_resources(
            resource_type=resource_type,
            resource_name=resource_name,
            namespace=namespace,
            all_namespaces=False,
            output="yaml",
        )
        return payload.get("data", "")

    async def describe_resource(
        self,
        resource_type: str,
        resource_name: str,
        namespace: Optional[str] = None,
    ) -> Dict[str, Any]:
        key = self._normalize_resource_key(resource_type)

        # Prefer specialized describe for core resources
        if key in {"pod", "pods", "po"}:
            ns = namespace or self._get_default_namespace()
            return await self.describe_pod(ns, resource_name)
        if key in {"deployment", "deployments", "deploy"}:
            ns = namespace or self._get_default_namespace()
            return await self.describe_deployment(ns, resource_name)
        if key in {"service", "services", "svc"}:
            ns = namespace or self._get_default_namespace()
            return await self.describe_service(ns, resource_name)
        if key in {"node", "nodes", "no"}:
            return await self.describe_node(resource_name)
        if key in {"namespace", "namespaces", "ns"}:
            return await self.describe_namespace(resource_name)

        # Fallback: return resource + related events (if namespaced)
        resource_obj = await self.get_resources(
            resource_type=resource_type,
            resource_name=resource_name,
            namespace=namespace,
            all_namespaces=False,
            output="json",
        )
        events = []
        try:
            ns = namespace or self._get_default_namespace()
            events = await self.get_events(ns, resource_name=resource_name)
        except Exception:
            events = []

        return {"resource": resource_obj.get("data"), "events": events}

    async def get_cluster_configuration(self) -> Dict[str, Any]:
        """kubectl config view -o json과 유사한 정보를 반환 (민감정보 제거)."""
        import yaml

        # 1) KUBECONFIG_PATH가 있으면 우선 사용
        kubeconfig_path = ""
        if settings.KUBECONFIG_PATH and os.path.exists(settings.KUBECONFIG_PATH):
            kubeconfig_path = settings.KUBECONFIG_PATH
        else:
            default_path = os.path.expanduser("~/.kube/config")
            if os.path.exists(default_path):
                kubeconfig_path = default_path

        if kubeconfig_path:
            with open(kubeconfig_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            # 민감정보 제거
            for user in data.get("users", []) or []:
                u = user.get("user", {}) or {}
                for key in ("token", "client-key-data", "client-certificate-data", "password"):
                    if key in u:
                        u[key] = "<redacted>"
                user["user"] = u
            return data

        # 2) in-cluster 환경: 최소 정보 제공
        cfg = client.Configuration.get_default_copy()
        ns = self._get_default_namespace()
        return {
            "clusters": [
                {
                    "name": "in-cluster",
                    "cluster": {
                        "server": cfg.host,
                        "certificate-authority": cfg.ssl_ca_cert,
                    },
                }
            ],
            "contexts": [
                {
                    "name": "in-cluster",
                    "context": {"cluster": "in-cluster", "namespace": ns},
                }
            ],
            "current-context": "in-cluster",
            "users": [{"name": "in-cluster", "user": {"token": "<redacted>"}}],
        }

    def _to_iso(self, value: Any) -> Optional[str]:
        if value is None:
            return None
        try:
            return value.isoformat()
        except Exception:
            return str(value)

    def _serialize_container_state(self, state: Any) -> Optional[Dict[str, Any]]:
        """
        ContainerState / ContainerStateTerminated / etc. 를 프론트에서 쓰기 쉬운 dict로 축약한다.
        (CrashLoopBackOff, ImagePullBackOff 등 Reason 판별 용도)
        """
        if state is None:
            return None

        result: Dict[str, Any] = {}

        waiting = getattr(state, "waiting", None)
        if waiting is not None:
            result["waiting"] = {
                "reason": getattr(waiting, "reason", None),
                "message": getattr(waiting, "message", None),
            }

        terminated = getattr(state, "terminated", None)
        if terminated is not None:
            result["terminated"] = {
                "reason": getattr(terminated, "reason", None),
                "message": getattr(terminated, "message", None),
                "exit_code": getattr(terminated, "exit_code", None),
                "signal": getattr(terminated, "signal", None),
                "started_at": self._to_iso(getattr(terminated, "started_at", None)),
                "finished_at": self._to_iso(getattr(terminated, "finished_at", None)),
            }

        running = getattr(state, "running", None)
        if running is not None:
            result["running"] = {
                "started_at": self._to_iso(getattr(running, "started_at", None)),
            }

        return result or None

    def _serialize_rbac_subject(self, subject: Any) -> Dict[str, Any]:
        if subject is None:
            return {}
        return {
            "kind": getattr(subject, "kind", None),
            "api_group": getattr(subject, "api_group", None),
            "name": getattr(subject, "name", None),
            "namespace": getattr(subject, "namespace", None),
        }

    def _serialize_policy_rule(self, rule: Any) -> Dict[str, Any]:
        if rule is None:
            return {}
        return {
            "verbs": list(getattr(rule, "verbs", None) or []),
            "api_groups": list(getattr(rule, "api_groups", None) or []),
            "resources": list(getattr(rule, "resources", None) or []),
            "resource_names": list(getattr(rule, "resource_names", None) or []),
            "non_resource_urls": list(getattr(rule, "non_resource_urls", None) or []),
        }

    def _summarize_allowed_topologies(self, allowed_topologies: Any) -> List[str]:
        """
        StorageClass.allowedTopologies 를 1줄 요약 리스트로 만든다.
        예: kubernetes.io/hostname In [node-a,node-b]
        """
        terms = list(allowed_topologies or [])
        if not terms:
            return []

        results: List[str] = []
        for term in terms:
            exprs = list(getattr(term, "match_label_expressions", None) or [])
            parts: List[str] = []
            for expr in exprs:
                key = getattr(expr, "key", None)
                values = list(getattr(expr, "values", None) or [])
                if not key:
                    continue
                if values:
                    preview = ", ".join(values[:3])
                    if len(values) > 3:
                        preview = f"{preview}, …(+{len(values) - 3})"
                    parts.append(f"{key} In [{preview}]")
                else:
                    parts.append(f"{key}")
            if parts:
                results.append(" AND ".join(parts))

        return results

    def _summarize_pv_source(self, pv: Any) -> Dict[str, Optional[str]]:
        """
        PV spec의 volume source를 간단히 요약한다.
        - source: CSI/NFS/Local/HostPath/...
        - driver: CSI driver (해당 시)
        - volume_handle: CSI volumeHandle (해당 시)
        """
        spec = getattr(pv, "spec", None)
        if spec is None:
            return {"source": None, "driver": None, "volume_handle": None}

        csi = getattr(spec, "csi", None)
        if csi is not None:
            return {
                "source": "CSI",
                "driver": getattr(csi, "driver", None),
                "volume_handle": getattr(csi, "volume_handle", None),
            }

        nfs = getattr(spec, "nfs", None)
        if nfs is not None:
            server = getattr(nfs, "server", None)
            path = getattr(nfs, "path", None)
            detail = None
            if server or path:
                detail = f"{server or ''}:{path or ''}".strip(":")
            return {"source": "NFS", "driver": detail, "volume_handle": None}

        local = getattr(spec, "local", None)
        if local is not None:
            path = getattr(local, "path", None)
            return {"source": "Local", "driver": path, "volume_handle": None}

        host_path = getattr(spec, "host_path", None)
        if host_path is not None:
            path = getattr(host_path, "path", None)
            return {"source": "HostPath", "driver": path, "volume_handle": None}

        aws_ebs = getattr(spec, "aws_elastic_block_store", None)
        if aws_ebs is not None:
            volume_id = getattr(aws_ebs, "volume_id", None)
            return {"source": "AWS EBS", "driver": volume_id, "volume_handle": None}

        gce_pd = getattr(spec, "gce_persistent_disk", None)
        if gce_pd is not None:
            pd_name = getattr(gce_pd, "pd_name", None)
            return {"source": "GCE PD", "driver": pd_name, "volume_handle": None}

        azure_disk = getattr(spec, "azure_disk", None)
        if azure_disk is not None:
            disk_name = getattr(azure_disk, "disk_name", None)
            return {"source": "AzureDisk", "driver": disk_name, "volume_handle": None}

        azure_file = getattr(spec, "azure_file", None)
        if azure_file is not None:
            share_name = getattr(azure_file, "share_name", None)
            return {"source": "AzureFile", "driver": share_name, "volume_handle": None}

        # 기타 source는 너무 많아서 이름만 표시한다.
        for attr, label in [
            ("cephfs", "CephFS"),
            ("rbd", "RBD"),
            ("iscsi", "iSCSI"),
            ("cinder", "Cinder"),
            ("glusterfs", "GlusterFS"),
            ("vsphere_volume", "vSphere"),
            ("portworx_volume", "Portworx"),
            ("quobyte", "Quobyte"),
            ("scale_io", "ScaleIO"),
            ("storageos", "StorageOS"),
        ]:
            if getattr(spec, attr, None) is not None:
                return {"source": label, "driver": None, "volume_handle": None}

        return {"source": "Unknown", "driver": None, "volume_handle": None}

    def _summarize_pv_node_affinity(self, pv: Any) -> Optional[str]:
        """
        PV spec.nodeAffinity.required 를 1줄로 요약한다.
        예: kubernetes.io/hostname In [node-a,node-b]
        """
        spec = getattr(pv, "spec", None)
        if spec is None:
            return None

        node_affinity = getattr(spec, "node_affinity", None)
        required = getattr(node_affinity, "required", None)
        terms = list(getattr(required, "node_selector_terms", None) or [])
        if not terms:
            return None

        parts: List[str] = []
        for term in terms:
            exprs = list(getattr(term, "match_expressions", None) or [])
            for expr in exprs:
                key = getattr(expr, "key", None)
                op = getattr(expr, "operator", None)
                values = list(getattr(expr, "values", None) or [])
                if not key or not op:
                    continue
                if values:
                    preview = ", ".join(values[:3])
                    if len(values) > 3:
                        preview = f"{preview}, …(+{len(values) - 3})"
                    parts.append(f"{key} {op} [{preview}]")
                else:
                    parts.append(f"{key} {op}")

        if not parts:
            return None

        # 너무 길어지는 경우 앞부분만 노출
        if len(parts) == 1:
            return parts[0]
        return f"{parts[0]} (+{len(parts) - 1} more)"
    
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

    async def describe_namespace(self, name: str) -> Dict:
        """네임스페이스 상세 정보 조회 (kubectl describe namespace와 유사)"""
        try:
            ns = self.v1.read_namespace(name)

            # 이벤트 조회 (Namespace 관련)
            events = self.v1.list_namespaced_event(
                namespace=name,
                field_selector=f"involvedObject.name={name},involvedObject.kind=Namespace"
            )

            # 생성 시각 포맷
            created_at = None
            if hasattr(ns.metadata, "creation_timestamp") and ns.metadata.creation_timestamp:
                try:
                    if hasattr(ns.metadata.creation_timestamp, "isoformat"):
                        created_at = ns.metadata.creation_timestamp.isoformat()
                    else:
                        created_at = str(ns.metadata.creation_timestamp)
                except Exception as e:
                    print(f"[WARN] Failed to format namespace.creation_timestamp: {e}")
                    created_at = str(ns.metadata.creation_timestamp)

            describe_info: Dict[str, Any] = {
                "name": ns.metadata.name,
                "status": getattr(ns.status, "phase", None) if getattr(ns, "status", None) else None,
                "created_at": created_at,
                "labels": ns.metadata.labels or {},
                "annotations": ns.metadata.annotations or {},
                "events": [],
            }

            if events and events.items:
                for event in events.items:
                    describe_info["events"].append(
                        {
                            "type": event.type,
                            "reason": event.reason,
                            "message": event.message,
                            "count": event.count,
                            "first_timestamp": str(event.first_timestamp)
                            if getattr(event, "first_timestamp", None)
                            else None,
                            "last_timestamp": str(event.last_timestamp)
                            if getattr(event, "last_timestamp", None)
                            else None,
                        }
                    )

            return describe_info
        except ApiException as e:
            raise Exception(f"Failed to describe namespace: {e}")
    
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
                            "protocol": port.protocol,
                            "node_port": getattr(port, "node_port", None),
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

    async def check_service_connectivity(
        self,
        namespace: str,
        service_name: str,
        port: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Service/Endpoint 연결성 확인"""
        try:
            svc = self.v1.read_namespaced_service(service_name, namespace)
        except ApiException as e:
            raise Exception(f"Failed to get service: {e}")

        ports: List[Dict[str, Any]] = []
        for p in (svc.spec.ports or []):
            ports.append(
                {
                    "name": p.name,
                    "port": p.port,
                    "target_port": str(p.target_port) if p.target_port is not None else None,
                    "protocol": p.protocol,
                    "node_port": getattr(p, "node_port", None),
                }
            )

        requested_port = None
        if port is not None:
            requested_port = str(port).strip()

        matched_port: Optional[Dict[str, Any]] = None
        if requested_port:
            for p in ports:
                if requested_port == str(p.get("name") or ""):
                    matched_port = p
                    break
                if requested_port == str(p.get("port") or ""):
                    matched_port = p
                    break
                if requested_port == str(p.get("target_port") or ""):
                    matched_port = p
                    break

        ready_addresses: List[str] = []
        not_ready_addresses: List[str] = []
        endpoints_source = "endpoints"

        try:
            ep = self.v1.read_namespaced_endpoints(service_name, namespace)
            for subset in (ep.subsets or []):
                for addr in (subset.addresses or []):
                    ip = getattr(addr, "ip", None)
                    if ip:
                        ready_addresses.append(ip)
                for addr in (subset.not_ready_addresses or []):
                    ip = getattr(addr, "ip", None)
                    if ip:
                        not_ready_addresses.append(ip)
        except ApiException as e:
            if getattr(e, "status", None) != 404:
                raise Exception(f"Failed to get endpoints: {e}")

        ready_count = len(ready_addresses)
        not_ready_count = len(not_ready_addresses)
        endpoints_total = ready_count + not_ready_count

        if endpoints_total == 0:
            try:
                slices = await self.get_endpointslices(namespace)
                svc_slices = [s for s in slices if s.get("service_name") == service_name]
                if svc_slices:
                    endpoints_source = "endpointslices"
                    ready_count = sum(int(s.get("endpoints_ready") or 0) for s in svc_slices)
                    endpoints_total = sum(int(s.get("endpoints_total") or 0) for s in svc_slices)
                    not_ready_count = max(endpoints_total - ready_count, 0)
            except Exception:
                pass

        status = "ok"
        message = "Service has ready endpoints."
        if svc.spec.type == "ExternalName":
            status = "external_name"
            message = "ExternalName service uses external DNS; endpoints are not managed by the cluster."
        elif requested_port and matched_port is None:
            status = "port_not_found"
            message = "Requested port was not found on the service."
        elif endpoints_total == 0:
            status = "no_endpoints"
            message = "No endpoints found for this service."
        elif ready_count == 0:
            status = "no_ready_endpoints"
            message = "Endpoints exist but none are ready."

        return {
            "namespace": namespace,
            "service": service_name,
            "type": svc.spec.type,
            "cluster_ip": svc.spec.cluster_ip,
            "external_name": getattr(svc.spec, "external_name", None),
            "selector": svc.spec.selector or {},
            "ports": ports,
            "port_check": {
                "requested": requested_port,
                "matched": matched_port,
            } if requested_port else None,
            "endpoints": {
                "ready": ready_count,
                "not_ready": not_ready_count,
                "total": endpoints_total,
                "ready_addresses": ready_addresses[:50],
                "not_ready_addresses": not_ready_addresses[:50],
                "source": endpoints_source,
            },
            "status": status,
            "message": message,
        }
    
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

    async def get_replicasets(self, namespace: str, force_refresh: bool = False) -> List[ReplicaSetInfo]:
        """ReplicaSet 목록"""
        try:
            replicasets = self.apps_v1.list_namespaced_replica_set(namespace)
            result: List[ReplicaSetInfo] = []

            for rs in replicasets.items:
                image = rs.spec.template.spec.containers[0].image if rs.spec.template.spec.containers else ""

                owner = None
                owners = list(getattr(rs.metadata, "owner_references", None) or [])
                if owners:
                    o = owners[0]
                    kind = getattr(o, "kind", None)
                    name = getattr(o, "name", None)
                    if kind and name:
                        owner = f"{kind}/{name}"

                desired = rs.spec.replicas or 0
                ready = rs.status.ready_replicas or 0
                available = rs.status.available_replicas or 0

                status = "Healthy"
                if desired == 0 and ready == 0:
                    status = "Idle"
                elif ready != desired:
                    status = "Degraded"
                if desired > 0 and ready == 0:
                    status = "Unavailable"

                result.append(ReplicaSetInfo(
                    name=rs.metadata.name,
                    namespace=rs.metadata.namespace,
                    replicas=desired,
                    ready_replicas=ready,
                    available_replicas=available,
                    image=image,
                    owner=owner,
                    labels=rs.metadata.labels or {},
                    selector=getattr(rs.spec.selector, "match_labels", None) or {},
                    created_at=rs.metadata.creation_timestamp,
                    status=status,
                ))

            return result
        except ApiException as e:
            raise Exception(f"Failed to get replicasets: {e}")

    def _serialize_hpa_metrics(self, metrics: Any) -> List[Dict[str, Any]]:
        result: List[Dict[str, Any]] = []
        for m in (metrics or []):
            try:
                result.append({
                    "type": getattr(m, "type", None),
                    "resource": getattr(getattr(m, "resource", None), "name", None),
                    "target": getattr(getattr(getattr(m, "resource", None), "target", None), "average_utilization", None)
                    or getattr(getattr(getattr(m, "resource", None), "target", None), "average_value", None)
                    or getattr(getattr(getattr(m, "resource", None), "target", None), "value", None),
                })
            except Exception:
                result.append({"type": getattr(m, "type", None)})
        return result

    def _serialize_hpa_conditions(self, conditions: Any) -> List[Dict[str, Any]]:
        result: List[Dict[str, Any]] = []
        for c in (conditions or []):
            result.append({
                "type": getattr(c, "type", None),
                "status": getattr(c, "status", None),
                "reason": getattr(c, "reason", None),
                "message": getattr(c, "message", None),
                "last_transition_time": self._to_iso(getattr(c, "last_transition_time", None)),
            })
        return result

    async def get_hpas(self, namespace: str, force_refresh: bool = False) -> List[HPAInfo]:
        """HPA 목록"""
        try:
            api = self.autoscaling_v2
            if api is None:
                # fallback
                api = client.AutoscalingV1Api(api_client=self.api_client) if self.api_client else client.AutoscalingV1Api()

            hpas = api.list_namespaced_horizontal_pod_autoscaler(namespace)
            result: List[HPAInfo] = []

            for hpa in hpas.items:
                target = "-"
                try:
                    ref = getattr(hpa.spec, "scale_target_ref", None)
                    kind = getattr(ref, "kind", None)
                    name = getattr(ref, "name", None)
                    if kind and name:
                        target = f"{kind}/{name}"
                except Exception:
                    target = "-"

                metrics = self._serialize_hpa_metrics(getattr(hpa.spec, "metrics", None))
                conditions = self._serialize_hpa_conditions(getattr(hpa.status, "conditions", None))

                result.append(HPAInfo(
                    name=hpa.metadata.name,
                    namespace=hpa.metadata.namespace,
                    target_ref=target,
                    min_replicas=getattr(hpa.spec, "min_replicas", None),
                    max_replicas=getattr(hpa.spec, "max_replicas", 0) or 0,
                    current_replicas=getattr(hpa.status, "current_replicas", None),
                    desired_replicas=getattr(hpa.status, "desired_replicas", None),
                    metrics=metrics,
                    conditions=conditions,
                    last_scale_time=self._to_iso(getattr(hpa.status, "last_scale_time", None)),
                    created_at=hpa.metadata.creation_timestamp,
                ))

            return result
        except ApiException as e:
            raise Exception(f"Failed to get hpas: {e}")

    async def get_pdbs(self, namespace: str, force_refresh: bool = False) -> List[PDBInfo]:
        """PDB 목록"""
        try:
            api = self.policy_v1
            if api is None:
                # fallback: older clusters may have policy/v1beta1
                try:
                    api = client.PolicyV1beta1Api(api_client=self.api_client) if self.api_client else client.PolicyV1beta1Api()
                except Exception:
                    api = None
            if api is None:
                raise Exception("Policy API not available in this environment")

            pdbs = api.list_namespaced_pod_disruption_budget(namespace)
            result: List[PDBInfo] = []

            for pdb in pdbs.items:
                selector = {}
                try:
                    selector = getattr(getattr(pdb.spec, "selector", None), "match_labels", None) or {}
                except Exception:
                    selector = {}

                min_avail = getattr(pdb.spec, "min_available", None)
                max_unavail = getattr(pdb.spec, "max_unavailable", None)

                result.append(PDBInfo(
                    name=pdb.metadata.name,
                    namespace=pdb.metadata.namespace,
                    min_available=str(min_avail) if min_avail is not None else None,
                    max_unavailable=str(max_unavail) if max_unavail is not None else None,
                    current_healthy=getattr(pdb.status, "current_healthy", 0) or 0,
                    desired_healthy=getattr(pdb.status, "desired_healthy", 0) or 0,
                    disruptions_allowed=getattr(pdb.status, "disruptions_allowed", 0) or 0,
                    expected_pods=getattr(pdb.status, "expected_pods", 0) or 0,
                    selector=selector,
                    created_at=pdb.metadata.creation_timestamp,
                ))

            return result
        except ApiException as e:
            raise Exception(f"Failed to get pdbs: {e}")
    
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
                        ports = []
                        if getattr(spec, "ports", None):
                            for p in (spec.ports or []):
                                ports.append({
                                    "name": getattr(p, "name", None),
                                    "container_port": getattr(p, "container_port", None),
                                    "protocol": getattr(p, "protocol", None),
                                })
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
                            "requests": requests,
                            "ports": ports,
                        }
                
                if pod.status.container_statuses:
                    for container in pod.status.container_statuses:
                        container_info = {
                            "name": container.name,
                            "image": container.image,
                            "ready": container.ready,
                            "restart_count": container.restart_count,
                            "state": self._serialize_container_state(container.state),
                            "last_state": self._serialize_container_state(container.last_state),
                            "limits": None,
                            "requests": None,
                            "ports": [],
                        }
                        # limits/requests 추가
                        if container.name in container_specs:
                            container_info["limits"] = container_specs[container.name].get("limits")
                            container_info["requests"] = container_specs[container.name].get("requests")
                            container_info["ports"] = container_specs[container.name].get("ports") or []
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
                        ports = []
                        if getattr(spec, "ports", None):
                            for p in (spec.ports or []):
                                ports.append({
                                    "name": getattr(p, "name", None),
                                    "container_port": getattr(p, "container_port", None),
                                    "protocol": getattr(p, "protocol", None),
                                })
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
                            "requests": requests,
                            "ports": ports,
                        }
                
                if pod.status.container_statuses:
                    for container in pod.status.container_statuses:
                        container_info = {
                            "name": container.name,
                            "image": container.image,
                            "ready": container.ready,
                            "restart_count": container.restart_count,
                            "state": self._serialize_container_state(container.state),
                            "last_state": self._serialize_container_state(container.last_state),
                            "limits": None,
                            "requests": None,
                            "ports": [],
                        }
                        # limits/requests 추가
                        if container.name in container_specs:
                            container_info["limits"] = container_specs[container.name].get("limits")
                            container_info["requests"] = container_specs[container.name].get("requests")
                            container_info["ports"] = container_specs[container.name].get("ports") or []
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
                    cap_val = pvc.status.capacity.get("storage")
                    capacity = str(cap_val) if cap_val is not None else None

                requested = None
                try:
                    if pvc.spec.resources and pvc.spec.resources.requests:
                        req_val = pvc.spec.resources.requests.get("storage")
                        requested = str(req_val) if req_val is not None else None
                except Exception:
                    requested = None
                
                result.append(PVCInfo(
                    name=pvc.metadata.name,
                    namespace=pvc.metadata.namespace,
                    status=pvc.status.phase,
                    volume_name=pvc.spec.volume_name,
                    storage_class=pvc.spec.storage_class_name,
                    capacity=capacity,
                    requested=requested,
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
                source_info = self._summarize_pv_source(pv)
                node_affinity = self._summarize_pv_node_affinity(pv)

                claim_ref = None
                if pv.spec.claim_ref:
                    claim_ref = {
                        "namespace": pv.spec.claim_ref.namespace,
                        "name": pv.spec.claim_ref.name
                    }

                cap_val = None
                try:
                    cap_val = pv.spec.capacity.get("storage") if pv.spec.capacity else None
                except Exception:
                    cap_val = None
                
                result.append(PVInfo(
                    name=pv.metadata.name,
                    status=pv.status.phase,
                    capacity=str(cap_val) if cap_val is not None else "",
                    access_modes=pv.spec.access_modes or [],
                    storage_class=pv.spec.storage_class_name,
                    reclaim_policy=pv.spec.persistent_volume_reclaim_policy,
                    claim_ref=claim_ref,
                    volume_mode=getattr(pv.spec, "volume_mode", None),
                    source=source_info.get("source"),
                    driver=source_info.get("driver"),
                    volume_handle=source_info.get("volume_handle"),
                    node_affinity=node_affinity,
                    created_at=pv.metadata.creation_timestamp
                ))
            
            return result
        except ApiException as e:
            raise Exception(f"Failed to get PVs: {e}")

    async def get_pv(self, name: str) -> PVInfo:
        """PV 단건"""
        try:
            pv = self.v1.read_persistent_volume(name)

            source_info = self._summarize_pv_source(pv)
            node_affinity = self._summarize_pv_node_affinity(pv)

            claim_ref = None
            if pv.spec.claim_ref:
                claim_ref = {
                    "namespace": pv.spec.claim_ref.namespace,
                    "name": pv.spec.claim_ref.name,
                }

            cap_val = None
            try:
                cap_val = pv.spec.capacity.get("storage") if pv.spec.capacity else None
            except Exception:
                cap_val = None

            return PVInfo(
                name=pv.metadata.name,
                status=pv.status.phase,
                capacity=str(cap_val) if cap_val is not None else "",
                access_modes=pv.spec.access_modes or [],
                storage_class=pv.spec.storage_class_name,
                reclaim_policy=pv.spec.persistent_volume_reclaim_policy,
                claim_ref=claim_ref,
                volume_mode=getattr(pv.spec, "volume_mode", None),
                source=source_info.get("source"),
                driver=source_info.get("driver"),
                volume_handle=source_info.get("volume_handle"),
                node_affinity=node_affinity,
                created_at=pv.metadata.creation_timestamp,
            )
        except ApiException as e:
            raise Exception(f"Failed to get PV: {e}")

    async def get_storageclasses(self, force_refresh: bool = False) -> List[Dict[str, Any]]:
        """StorageClass 목록"""
        try:
            storage_v1 = client.StorageV1Api()
            scs = storage_v1.list_storage_class()

            result: List[Dict[str, Any]] = []
            for sc in scs.items:
                annotations = sc.metadata.annotations or {}
                is_default = annotations.get("storageclass.kubernetes.io/is-default-class") == "true" or annotations.get(
                    "storageclass.beta.kubernetes.io/is-default-class"
                ) == "true"

                mount_options = list(getattr(sc, "mount_options", None) or [])
                allowed_topologies = self._summarize_allowed_topologies(getattr(sc, "allowed_topologies", None))

                result.append({
                    "name": sc.metadata.name,
                    "provisioner": sc.provisioner,
                    "reclaim_policy": getattr(sc, "reclaim_policy", None),
                    "volume_binding_mode": getattr(sc, "volume_binding_mode", None),
                    "allow_volume_expansion": getattr(sc, "allow_volume_expansion", None),
                    "is_default": is_default,
                    "parameters": getattr(sc, "parameters", None) or {},
                    "mount_options": mount_options,
                    "allowed_topologies": allowed_topologies,
                    "created_at": self._to_iso(getattr(sc.metadata, "creation_timestamp", None)),
                })

            return result
        except ApiException as e:
            raise Exception(f"Failed to get StorageClasses: {e}")

    async def get_storageclass(self, name: str) -> Dict[str, Any]:
        """StorageClass 단건"""
        try:
            storage_v1 = client.StorageV1Api()
            sc = storage_v1.read_storage_class(name)

            annotations = sc.metadata.annotations or {}
            is_default = annotations.get("storageclass.kubernetes.io/is-default-class") == "true" or annotations.get(
                "storageclass.beta.kubernetes.io/is-default-class"
            ) == "true"

            mount_options = list(getattr(sc, "mount_options", None) or [])
            allowed_topologies = self._summarize_allowed_topologies(getattr(sc, "allowed_topologies", None))

            return {
                "name": sc.metadata.name,
                "provisioner": sc.provisioner,
                "reclaim_policy": getattr(sc, "reclaim_policy", None),
                "volume_binding_mode": getattr(sc, "volume_binding_mode", None),
                "allow_volume_expansion": getattr(sc, "allow_volume_expansion", None),
                "is_default": is_default,
                "parameters": getattr(sc, "parameters", None) or {},
                "mount_options": mount_options,
                "allowed_topologies": allowed_topologies,
                "created_at": self._to_iso(getattr(sc.metadata, "creation_timestamp", None)),
            }
        except ApiException as e:
            raise Exception(f"Failed to get StorageClass: {e}")

    async def get_volumeattachments(self, force_refresh: bool = False) -> List[Dict[str, Any]]:
        """VolumeAttachment 목록"""
        try:
            storage_v1 = client.StorageV1Api()
            vas = storage_v1.list_volume_attachment()

            result: List[Dict[str, Any]] = []
            for va in vas.items:
                source = getattr(va.spec, "source", None)
                persistent_volume_name = getattr(source, "persistent_volume_name", None) if source else None

                status = getattr(va, "status", None)
                attach_error = getattr(status, "attach_error", None) if status else None
                detach_error = getattr(status, "detach_error", None) if status else None

                result.append({
                    "name": va.metadata.name,
                    "attacher": getattr(va.spec, "attacher", None),
                    "node_name": getattr(va.spec, "node_name", None),
                    "persistent_volume_name": persistent_volume_name,
                    "attached": getattr(status, "attached", None) if status else None,
                    "attach_error": {
                        "time": self._to_iso(getattr(attach_error, "time", None)),
                        "message": getattr(attach_error, "message", None),
                    } if attach_error else None,
                    "detach_error": {
                        "time": self._to_iso(getattr(detach_error, "time", None)),
                        "message": getattr(detach_error, "message", None),
                    } if detach_error else None,
                    "created_at": self._to_iso(getattr(va.metadata, "creation_timestamp", None)),
                })

            return result
        except ApiException as e:
            raise Exception(f"Failed to get VolumeAttachments: {e}")
    
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
                backends = set()
                # default backend
                default_backend = getattr(ing.spec, "default_backend", None)
                if default_backend and getattr(default_backend, "service", None):
                    svc = default_backend.service
                    if getattr(svc, "name", None):
                        backends.add(svc.name)
                # rules backends
                for rule in (ing.spec.rules or []):
                    http = getattr(rule, "http", None)
                    if not http or not getattr(http, "paths", None):
                        continue
                    for path in (http.paths or []):
                        backend = getattr(path, "backend", None)
                        service = getattr(backend, "service", None) if backend else None
                        if service and getattr(service, "name", None):
                            backends.add(service.name)
                result.append({
                    "name": ing.metadata.name,
                    "hosts": hosts,
                    "class": ing.spec.ingress_class_name,
                    "backends": sorted(list(backends))
                })
            return result
        except ApiException as e:
            raise Exception(f"Failed to get ingresses: {e}")

    async def get_ingressclasses(self) -> List[Dict]:
        """IngressClass 목록 조회 (cluster-scoped)"""
        try:
            networking_v1 = client.NetworkingV1Api()
            classes = networking_v1.list_ingress_class()
            result: List[Dict] = []
            for ic in classes.items:
                annotations = ic.metadata.annotations or {}
                is_default = annotations.get("ingressclass.kubernetes.io/is-default-class") == "true"
                params = None
                if getattr(ic.spec, "parameters", None):
                    p = ic.spec.parameters
                    params = {
                        "api_group": getattr(p, "api_group", None),
                        "kind": getattr(p, "kind", None),
                        "name": getattr(p, "name", None),
                        "scope": getattr(p, "scope", None),
                        "namespace": getattr(p, "namespace", None),
                    }
                result.append({
                    "name": ic.metadata.name,
                    "controller": getattr(ic.spec, "controller", None),
                    "is_default": is_default,
                    "parameters": params,
                    "created_at": str(ic.metadata.creation_timestamp) if ic.metadata.creation_timestamp else None,
                })
            return result
        except ApiException as e:
            raise Exception(f"Failed to get ingressclasses: {e}")

    async def get_endpoints(self, namespace: str) -> List[Dict]:
        """Endpoints 목록 조회"""
        try:
            eps = self.v1.list_namespaced_endpoints(namespace)
            result: List[Dict] = []
            for ep in eps.items:
                ready_addresses: List[str] = []
                not_ready_addresses: List[str] = []
                ready_targets: List[Dict[str, Any]] = []
                not_ready_targets: List[Dict[str, Any]] = []
                ports: List[Dict] = []

                for subset in (ep.subsets or []):
                    for addr in (subset.addresses or []):
                        ip = getattr(addr, "ip", None)
                        if ip:
                            ready_addresses.append(ip)
                        target_ref = getattr(addr, "target_ref", None)
                        ready_targets.append({
                            "ip": ip,
                            "node_name": getattr(addr, "node_name", None),
                            "target_ref": {
                                "kind": getattr(target_ref, "kind", None) if target_ref else None,
                                "name": getattr(target_ref, "name", None) if target_ref else None,
                                "namespace": getattr(target_ref, "namespace", None) if target_ref else None,
                                "uid": getattr(target_ref, "uid", None) if target_ref else None,
                            } if target_ref else None,
                        })
                    for addr in (subset.not_ready_addresses or []):
                        ip = getattr(addr, "ip", None)
                        if ip:
                            not_ready_addresses.append(ip)
                        target_ref = getattr(addr, "target_ref", None)
                        not_ready_targets.append({
                            "ip": ip,
                            "node_name": getattr(addr, "node_name", None),
                            "target_ref": {
                                "kind": getattr(target_ref, "kind", None) if target_ref else None,
                                "name": getattr(target_ref, "name", None) if target_ref else None,
                                "namespace": getattr(target_ref, "namespace", None) if target_ref else None,
                                "uid": getattr(target_ref, "uid", None) if target_ref else None,
                            } if target_ref else None,
                        })
                    for p in (subset.ports or []):
                        ports.append({
                            "name": getattr(p, "name", None),
                            "port": getattr(p, "port", None),
                            "protocol": getattr(p, "protocol", None),
                        })

                # de-dup ports
                seen = set()
                dedup_ports = []
                for p in ports:
                    key = (p.get("name"), p.get("port"), p.get("protocol"))
                    if key in seen:
                        continue
                    seen.add(key)
                    dedup_ports.append(p)

                result.append({
                    "name": ep.metadata.name,
                    "namespace": ep.metadata.namespace,
                    "ready_count": len(ready_addresses),
                    "not_ready_count": len(not_ready_addresses),
                    "ready_addresses": ready_addresses[:50],
                    "not_ready_addresses": not_ready_addresses[:50],
                    "ready_targets": ready_targets[:50],
                    "not_ready_targets": not_ready_targets[:50],
                    "ports": dedup_ports,
                    "created_at": str(ep.metadata.creation_timestamp) if ep.metadata.creation_timestamp else None,
                })
            return result
        except ApiException as e:
            raise Exception(f"Failed to get endpoints: {e}")

    async def get_endpointslices(self, namespace: str) -> List[Dict]:
        """EndpointSlice 목록 조회 (discovery.k8s.io/v1)"""
        try:
            # NOTE: Some clusters may return EndpointSlice objects with `endpoints: null`,
            # which can break the typed DiscoveryV1Api deserialization (ValueError).
            # Use CustomObjectsApi (unstructured) to be resilient.
            custom_api = client.CustomObjectsApi()
            slices = custom_api.list_namespaced_custom_object(
                group="discovery.k8s.io",
                version="v1",
                namespace=namespace,
                plural="endpointslices",
            )
            result: List[Dict] = []
            for es in (slices.get("items", []) or []):
                metadata = es.get("metadata", {}) or {}
                labels = metadata.get("labels", {}) or {}
                service_name = labels.get("kubernetes.io/service-name")
                total = 0
                ready = 0
                for e in (es.get("endpoints", []) or []):
                    total += 1
                    cond = e.get("conditions", {}) or {}
                    is_ready = cond.get("ready", None)
                    if is_ready is True or is_ready is None:
                        # ready==None can appear; treat as ready-ish for high-level summary
                        ready += 1
                ports: List[Dict] = []
                for p in (es.get("ports", []) or []):
                    ports.append({
                        "name": p.get("name"),
                        "port": p.get("port"),
                        "protocol": p.get("protocol"),
                    })
                result.append({
                    "name": metadata.get("name"),
                    "namespace": metadata.get("namespace"),
                    "service_name": service_name,
                    "address_type": es.get("addressType"),
                    "endpoints_total": total,
                    "endpoints_ready": ready,
                    "ports": ports,
                    "created_at": metadata.get("creationTimestamp"),
                })
            return result
        except ApiException as e:
            raise Exception(f"Failed to get endpointslices: {e}")

    async def get_networkpolicies(self, namespace: str) -> List[Dict]:
        """NetworkPolicy 목록 조회"""
        try:
            networking_v1 = client.NetworkingV1Api()
            policies = networking_v1.list_namespaced_network_policy(namespace)
            result: List[Dict] = []

            def _selector_to_dict(selector: Any) -> Dict[str, Any]:
                if not selector:
                    return {"match_labels": {}, "match_expressions": []}
                return {
                    "match_labels": getattr(selector, "match_labels", None) or {},
                    "match_expressions": [
                        {
                            "key": getattr(expr, "key", None),
                            "operator": getattr(expr, "operator", None),
                            "values": getattr(expr, "values", None),
                        }
                        for expr in (getattr(selector, "match_expressions", None) or [])
                    ],
                }

            def _selects_all_pods(selector: Any) -> bool:
                if not selector:
                    return True
                ml = getattr(selector, "match_labels", None) or {}
                me = getattr(selector, "match_expressions", None) or []
                return len(ml) == 0 and len(me) == 0

            def _policy_types(spec: Any) -> List[str]:
                if not spec:
                    return []
                explicit = list(getattr(spec, "policy_types", None) or [])
                if explicit:
                    return explicit
                inferred: List[str] = []
                if getattr(spec, "ingress", None) is not None:
                    inferred.append("Ingress")
                if getattr(spec, "egress", None) is not None:
                    inferred.append("Egress")
                return inferred

            def _port_to_dict(p: Any) -> Dict[str, Any]:
                if p is None:
                    return {}
                port = getattr(p, "port", None)
                # IntOrString can be int or str
                port_value = None if port is None else str(port)
                return {
                    "protocol": getattr(p, "protocol", None),
                    "port": port_value,
                    "end_port": getattr(p, "end_port", None),
                }

            def _peer_to_dict(peer: Any) -> Dict[str, Any]:
                if peer is None:
                    return {}
                ip_block = getattr(peer, "ip_block", None)
                ns_sel = getattr(peer, "namespace_selector", None)
                pod_sel = getattr(peer, "pod_selector", None)
                return {
                    "ip_block": {
                        "cidr": getattr(ip_block, "cidr", None),
                        "except": list(getattr(ip_block, "_except", None) or []),
                    } if ip_block is not None else None,
                    "namespace_selector": _selector_to_dict(ns_sel) if ns_sel is not None else None,
                    "pod_selector": _selector_to_dict(pod_sel) if pod_sel is not None else None,
                }

            def _ingress_rules(spec: Any) -> List[Dict[str, Any]]:
                rules = getattr(spec, "ingress", None)
                if rules is None:
                    return []
                out: List[Dict[str, Any]] = []
                for r in (rules or []):
                    peers = list(getattr(r, "_from", None) or getattr(r, "from", None) or [])
                    ports = list(getattr(r, "ports", None) or [])
                    out.append({
                        "from": [_peer_to_dict(p) for p in peers][:20],
                        "ports": [_port_to_dict(p) for p in ports][:50],
                    })
                return out

            def _egress_rules(spec: Any) -> List[Dict[str, Any]]:
                rules = getattr(spec, "egress", None)
                if rules is None:
                    return []
                out: List[Dict[str, Any]] = []
                for r in (rules or []):
                    peers = list(getattr(r, "to", None) or [])
                    ports = list(getattr(r, "ports", None) or [])
                    out.append({
                        "to": [_peer_to_dict(p) for p in peers][:20],
                        "ports": [_port_to_dict(p) for p in ports][:50],
                    })
                return out

            for np in policies.items:
                spec = getattr(np, "spec", None)
                ps = getattr(spec, "pod_selector", None) if spec else None
                selector = _selector_to_dict(ps)
                types = _policy_types(spec)
                ingress = getattr(spec, "ingress", None) if spec else None
                egress = getattr(spec, "egress", None) if spec else None
                default_deny_ingress = ("Ingress" in types) and (ingress is None or len(ingress or []) == 0)
                default_deny_egress = ("Egress" in types) and (egress is None or len(egress or []) == 0)
                result.append({
                    "name": np.metadata.name,
                    "namespace": np.metadata.namespace,
                    "pod_selector": selector,
                    "selects_all_pods": _selects_all_pods(ps),
                    "policy_types": types,
                    "default_deny_ingress": default_deny_ingress,
                    "default_deny_egress": default_deny_egress,
                    "ingress_rules": len(ingress or []) if spec else 0,
                    "egress_rules": len(egress or []) if spec else 0,
                    "ingress": _ingress_rules(spec) if spec else [],
                    "egress": _egress_rules(spec) if spec else [],
                    "created_at": str(np.metadata.creation_timestamp) if np.metadata.creation_timestamp else None,
                })
            return result
        except ApiException as e:
            raise Exception(f"Failed to get networkpolicies: {e}")

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

    async def get_ingress_detail(self, namespace: str, name: str) -> Dict[str, Any]:
        """Ingress 상세 요약 (주소/규칙/백엔드/TLS/클래스/이벤트)"""
        try:
            networking_v1 = client.NetworkingV1Api()
            ing = networking_v1.read_namespaced_ingress(name, namespace)

            annotations = ing.metadata.annotations or {}
            spec_class_name = getattr(ing.spec, "ingress_class_name", None)
            anno_class_name = annotations.get("kubernetes.io/ingress.class")

            ingress_class_name = None
            ingress_class_source = None  # spec | annotation | default | None

            if spec_class_name:
                ingress_class_name = spec_class_name
                ingress_class_source = "spec"
            elif anno_class_name:
                ingress_class_name = anno_class_name
                ingress_class_source = "annotation"

            # IngressClass controller (optional)
            class_controller = None
            class_is_default = None
            if ingress_class_name:
                try:
                    ic = networking_v1.read_ingress_class(ingress_class_name)
                    class_controller = getattr(ic.spec, "controller", None) if getattr(ic, "spec", None) else None
                    ic_annotations = ic.metadata.annotations or {}
                    class_is_default = ic_annotations.get("ingressclass.kubernetes.io/is-default-class") == "true"
                except Exception:
                    pass
            else:
                # No explicit class: try default ingressclass (candidate only)
                try:
                    classes = networking_v1.list_ingress_class().items
                    defaults = []
                    for ic in classes:
                        ic_annotations = ic.metadata.annotations or {}
                        if ic_annotations.get("ingressclass.kubernetes.io/is-default-class") == "true":
                            defaults.append(ic)
                    if len(defaults) == 1:
                        ic = defaults[0]
                        ingress_class_name = ic.metadata.name
                        ingress_class_source = "default"
                        class_controller = getattr(ic.spec, "controller", None) if getattr(ic, "spec", None) else None
                        class_is_default = True
                    elif len(defaults) > 1:
                        # ambiguous: don't guess; return none and let UI show unknown
                        ingress_class_name = None
                        ingress_class_source = None
                except Exception:
                    pass

            # Addresses
            addresses: List[Dict[str, Optional[str]]] = []
            lb = getattr(ing.status, "load_balancer", None)
            for item in (getattr(lb, "ingress", None) or []):
                addresses.append({
                    "ip": getattr(item, "ip", None),
                    "hostname": getattr(item, "hostname", None),
                })

            # TLS
            tls: List[Dict[str, Any]] = []
            for t in (getattr(ing.spec, "tls", None) or []):
                tls.append({
                    "secret_name": getattr(t, "secret_name", None),
                    "hosts": list(getattr(t, "hosts", None) or []),
                })

            def _backend_to_dict(backend: Any) -> Dict[str, Any]:
                if backend is None:
                    return {}
                svc = getattr(backend, "service", None)
                if svc is not None:
                    port_obj = getattr(svc, "port", None)
                    port = None
                    if port_obj is not None:
                        port = getattr(port_obj, "number", None) or getattr(port_obj, "name", None)
                    return {
                        "type": "service",
                        "service": {
                            "name": getattr(svc, "name", None),
                            "port": port,
                        },
                    }
                res = getattr(backend, "resource", None)
                if res is not None:
                    return {
                        "type": "resource",
                        "resource": client.ApiClient().sanitize_for_serialization(res),
                    }
                return {}

            # Default backend
            default_backend = _backend_to_dict(getattr(ing.spec, "default_backend", None))

            # Rules + paths
            rules: List[Dict[str, Any]] = []
            for rule in (getattr(ing.spec, "rules", None) or []):
                http = getattr(rule, "http", None)
                paths: List[Dict[str, Any]] = []
                if http and getattr(http, "paths", None):
                    for p in (http.paths or []):
                        paths.append({
                            "path": getattr(p, "path", None),
                            "path_type": getattr(p, "path_type", None),
                            "backend": _backend_to_dict(getattr(p, "backend", None)),
                        })
                rules.append({
                    "host": getattr(rule, "host", None),
                    "paths": paths,
                })

            # Events (best-effort)
            events: List[Dict[str, Any]] = []
            try:
                raw_events = self.v1.list_namespaced_event(namespace)
                for ev in raw_events.items:
                    inv = getattr(ev, "involved_object", None)
                    if not inv:
                        continue
                    if getattr(inv, "kind", None) != "Ingress":
                        continue
                    if getattr(inv, "name", None) != name:
                        continue
                    events.append({
                        "type": getattr(ev, "type", None),
                        "reason": getattr(ev, "reason", None),
                        "message": getattr(ev, "message", None),
                        "count": getattr(ev, "count", None),
                        "first_timestamp": self._to_iso(getattr(ev, "first_timestamp", None)),
                        "last_timestamp": self._to_iso(getattr(ev, "last_timestamp", None)),
                    })
                # sort by last_timestamp desc (string iso; None last)
                events.sort(key=lambda e: (e.get("last_timestamp") is not None, e.get("last_timestamp") or ""), reverse=True)
                events = events[:10]
            except Exception:
                pass

            return {
                "name": ing.metadata.name,
                "namespace": ing.metadata.namespace,
                "class": ingress_class_name,
                "class_source": ingress_class_source,
                "class_controller": class_controller,
                "class_is_default": class_is_default,
                "addresses": addresses,
                "tls": tls,
                "default_backend": default_backend,
                "rules": rules,
                "events": events,
                "created_at": str(ing.metadata.creation_timestamp) if ing.metadata.creation_timestamp else None,
            }
        except ApiException as e:
            raise Exception(f"Failed to get ingress detail: {e}")
    
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

    async def get_pod_rbac(self, namespace: str, name: str, include_authenticated: bool = False) -> Dict[str, Any]:
        """
        Pod → ServiceAccount → (RoleBinding/ClusterRoleBinding) → (Role/ClusterRole rules) 체인을 조회한다.

        주의: system:authenticated 는 모든 ServiceAccount(및 사용자)가 포함될 수 있는 광범위 그룹이므로,
        include_authenticated=True 일 때만 포함한다.
        """
        rbac_v1 = client.RbacAuthorizationV1Api()

        pod = self.v1.read_namespaced_pod(name, namespace)
        service_account_name = getattr(pod.spec, "service_account_name", None) or "default"
        service_account_user = f"system:serviceaccount:{namespace}:{service_account_name}"
        service_account_groups = {
            "system:serviceaccounts",
            f"system:serviceaccounts:{namespace}",
        }

        result: Dict[str, Any] = {
            "pod": {"name": name, "namespace": namespace},
            "service_account": {"name": service_account_name, "namespace": namespace},
            "role_bindings": [],
            "cluster_role_bindings": [],
            "errors": [],
        }

        def subject_match_info(subject: Any) -> Optional[Dict[str, Any]]:
            if subject is None:
                return None
            kind = getattr(subject, "kind", None)
            subj_name = getattr(subject, "name", None)
            subj_ns = getattr(subject, "namespace", None)

            if kind == "ServiceAccount":
                if subj_name == service_account_name and (subj_ns == namespace or subj_ns is None):
                    return {
                        "reason": "serviceaccount",
                        "broad": False,
                        "subject": self._serialize_rbac_subject(subject),
                    }
                return None
            if kind == "User":
                if subj_name == service_account_user:
                    return {
                        "reason": "user:system:serviceaccount",
                        "broad": False,
                        "subject": self._serialize_rbac_subject(subject),
                    }
                return None
            if kind == "Group":
                if subj_name in service_account_groups:
                    return {
                        "reason": "group:serviceaccounts",
                        "broad": False,
                        "subject": self._serialize_rbac_subject(subject),
                    }
                if subj_name == "system:authenticated":
                    return {
                        "reason": "group:system:authenticated",
                        "broad": True,
                        "subject": self._serialize_rbac_subject(subject),
                    }
                return None
            return None

        def resolve_role_ref(role_ref: Any, binding_namespace: Optional[str]) -> Dict[str, Any]:
            info: Dict[str, Any] = {
                "api_group": getattr(role_ref, "api_group", None),
                "kind": getattr(role_ref, "kind", None),
                "name": getattr(role_ref, "name", None),
                "rules": [],
                "error": None,
            }

            try:
                kind = info["kind"]
                ref_name = info["name"]
                if kind == "Role":
                    if not binding_namespace:
                        raise Exception("Missing namespace for Role ref")
                    role = rbac_v1.read_namespaced_role(ref_name, binding_namespace)
                    info["rules"] = [self._serialize_policy_rule(r) for r in (role.rules or [])]
                elif kind == "ClusterRole":
                    cluster_role = rbac_v1.read_cluster_role(ref_name)
                    info["rules"] = [self._serialize_policy_rule(r) for r in (cluster_role.rules or [])]
                else:
                    info["error"] = f"Unsupported roleRef kind: {kind}"
            except ApiException as e:
                info["error"] = f"Failed to resolve roleRef: {e.status} {e.reason}"
            except Exception as e:
                info["error"] = str(e)

            return info

        # Namespaced RoleBindings
        try:
            role_bindings = rbac_v1.list_namespaced_role_binding(namespace)
            for rb in role_bindings.items:
                subjects = list(getattr(rb, "subjects", None) or [])
                matched_by = [m for m in (subject_match_info(s) for s in subjects) if m]
                if not matched_by:
                    continue
                is_broad = any(m.get("broad") for m in matched_by)
                if is_broad and not include_authenticated:
                    # system:authenticated 만으로 매칭되는 케이스는 너무 광범위하므로 기본적으로 숨긴다.
                    if all(m.get("reason") == "group:system:authenticated" for m in matched_by):
                        continue

                role_ref = getattr(rb, "role_ref", None)
                role_ref_info = resolve_role_ref(role_ref, namespace) if role_ref is not None else {
                    "api_group": None,
                    "kind": None,
                    "name": None,
                    "rules": [],
                    "error": "Missing roleRef",
                }

                result["role_bindings"].append({
                    "name": rb.metadata.name,
                    "namespace": namespace,
                    "subjects": [self._serialize_rbac_subject(s) for s in subjects],
                    "matched_by": matched_by,
                    "is_broad": is_broad,
                    "role_ref": {
                        "api_group": getattr(role_ref, "api_group", None) if role_ref else None,
                        "kind": getattr(role_ref, "kind", None) if role_ref else None,
                        "name": getattr(role_ref, "name", None) if role_ref else None,
                    },
                    "resolved_role": role_ref_info,
                    "created_at": self._to_iso(getattr(rb.metadata, "creation_timestamp", None)),
                })
        except ApiException as e:
            result["errors"].append(f"Failed to list RoleBindings: {e.status} {e.reason}")

        # ClusterRoleBindings
        try:
            cluster_role_bindings = rbac_v1.list_cluster_role_binding()
            for crb in cluster_role_bindings.items:
                subjects = list(getattr(crb, "subjects", None) or [])
                matched_by = [m for m in (subject_match_info(s) for s in subjects) if m]
                if not matched_by:
                    continue
                is_broad = any(m.get("broad") for m in matched_by)
                if is_broad and not include_authenticated:
                    if all(m.get("reason") == "group:system:authenticated" for m in matched_by):
                        continue

                role_ref = getattr(crb, "role_ref", None)
                role_ref_info = resolve_role_ref(role_ref, None) if role_ref is not None else {
                    "api_group": None,
                    "kind": None,
                    "name": None,
                    "rules": [],
                    "error": "Missing roleRef",
                }

                result["cluster_role_bindings"].append({
                    "name": crb.metadata.name,
                    "subjects": [self._serialize_rbac_subject(s) for s in subjects],
                    "matched_by": matched_by,
                    "is_broad": is_broad,
                    "role_ref": {
                        "api_group": getattr(role_ref, "api_group", None) if role_ref else None,
                        "kind": getattr(role_ref, "kind", None) if role_ref else None,
                        "name": getattr(role_ref, "name", None) if role_ref else None,
                    },
                    "resolved_role": role_ref_info,
                    "created_at": self._to_iso(getattr(crb.metadata, "creation_timestamp", None)),
                })
        except ApiException as e:
            result["errors"].append(f"Failed to list ClusterRoleBindings: {e.status} {e.reason}")

        return result
    
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
        """Node 목록 조회"""
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
        """Node 상세 정보 조회"""
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
    
    def _parse_cpu_usage(self, cpu_str: str) -> float:
        """CPU 사용량을 millicores 단위로 변환"""
        if not cpu_str or cpu_str == "0":
            return 0
        
        try:
            if cpu_str.endswith("n"):
                return int(cpu_str[:-1]) / 1_000_000
            elif cpu_str.endswith("u"):
                return int(cpu_str[:-1]) / 1_000
            elif cpu_str.endswith("m"):
                return int(cpu_str[:-1])
            else:
                # 숫자만 있는 경우 cores 단위로 간주
                return int(cpu_str) * 1000
        except (ValueError, TypeError):
            print(f"[WARN] Failed to parse CPU usage: {cpu_str}")
            return 0

    def _parse_memory_usage(self, memory_str: str) -> float:
        """메모리 사용량을 Mi 단위로 변환"""
        if not memory_str or memory_str == "0":
            return 0
            
        try:
            if memory_str.endswith("Ki"):
                return int(memory_str[:-2]) / 1024
            elif memory_str.endswith("Mi"):
                return int(memory_str[:-2])
            elif memory_str.endswith("Gi"):
                return int(memory_str[:-2]) * 1024
            else:
                # 숫자만 있는 경우 bytes 단위로 간주
                return int(memory_str) / (1024 * 1024)
        except (ValueError, TypeError):
            print(f"[WARN] Failed to parse memory usage: {memory_str}")
            return 0

    async def get_pod_metrics(self, namespace: Optional[str] = None) -> List[Dict]:
        """Pod 리소스 사용량 조회 (kubectl top pods)"""
        import time

        max_retries = METRICS_MAX_RETRIES
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
                        _request_timeout=METRICS_REQUEST_TIMEOUT  # 메트릭 서버 응답 지연 대응
                    )
                else:
                    # 전체 네임스페이스의 Pod 메트릭
                    print(f"[DEBUG] Fetching pod metrics for all namespaces (attempt {attempt}/{max_retries})")
                    metrics = custom_api.list_cluster_custom_object(
                        group="metrics.k8s.io",
                        version="v1beta1",
                        plural="pods",
                        _request_timeout=METRICS_REQUEST_TIMEOUT  # 메트릭 서버 응답 지연 대응
                    )
                
                result = []
                for item in metrics.get("items", []):
                    pod_name = item["metadata"]["name"]
                    pod_namespace = item["metadata"]["namespace"]
                    timestamp = item.get("timestamp")
                    window = item.get("window")
                    
                    # 컨테이너별 리소스 사용량 파싱
                    total_cpu = 0
                    total_memory = 0
                    for container in item.get("containers", []):
                        usage = container.get("usage", {})
                        total_cpu += self._parse_cpu_usage(usage.get("cpu", "0"))
                        total_memory += self._parse_memory_usage(usage.get("memory", "0"))
                    
                    result.append({
                        "namespace": pod_namespace,
                        "name": pod_name,
                        "cpu": f"{int(total_cpu)}m",
                        "memory": f"{int(total_memory)}Mi",
                        # 메트릭 수집 시각/윈도우 (metrics.k8s.io 기준)
                        "timestamp": timestamp,
                        "window": window,
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
                plural="nodes",
                _request_timeout=METRICS_REQUEST_TIMEOUT  # 메트릭 서버 응답 지연 대응
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
                timestamp = item.get("timestamp")
                window = item.get("window")
                
                # 리소스 사용량 파싱
                cpu_value = self._parse_cpu_usage(usage.get("cpu", "0"))
                memory_value = self._parse_memory_usage(usage.get("memory", "0"))
                
                # 용량 대비 사용률 계산
                capacity = node_capacity.get(node_name, {})
                cpu_capacity_str = capacity.get("cpu", "0")
                memory_capacity_str = capacity.get("memory", "0")
                
                # CPU 용량 파싱
                cpu_capacity = self._parse_cpu_usage(cpu_capacity_str)
                
                # Memory 용량 파싱
                memory_capacity = self._parse_memory_usage(memory_capacity_str)
                
                cpu_percent = (cpu_value / cpu_capacity * 100) if cpu_capacity > 0 else 0
                memory_percent = (memory_value / memory_capacity * 100) if memory_capacity > 0 else 0
                
                result.append({
                    "name": node_name,
                    "cpu": f"{int(cpu_value)}m",
                    "cpu_percent": f"{int(cpu_percent)}%",
                    "memory": f"{int(memory_value)}Mi",
                    "memory_percent": f"{int(memory_percent)}%",
                    # 메트릭 수집 시각/윈도우 (metrics.k8s.io 기준)
                    "timestamp": timestamp,
                    "window": window,
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
