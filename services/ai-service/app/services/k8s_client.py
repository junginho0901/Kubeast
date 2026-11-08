"""
K8s Service HTTP Client
MSA 환경에서 K8s Service와 HTTP로 통신
"""
from typing import List, Optional, Dict
from urllib.parse import quote

from app.services.ai.access import HEADER as ACCESS_HEADER, RECORD_HEADER, REQUESTS_HEADER, from_header, merge, trail_from_header
from app.services.http_shared import ScopedClient

K8S_SERVICE_URL = "http://k8s-service:8002/api/v1"


def _seg(value: object) -> str:
    """One path segment: a name, which may come from a model's tool call, never reaches another route."""
    text = str(value)
    # quote leaves dots alone and httpx resolves dot segments; no Kubernetes name is one of these.
    if text in (".", ".."):
        raise ValueError(f"not a name: {text!r}")
    return quote(text, safe="")


class K8sServiceClient:
    """K8s Service HTTP 클라이언트"""

    def __init__(self, authorization: Optional[str] = None, cluster_name: Optional[str] = None):
        self.base_url = K8S_SERVICE_URL
        headers: Dict[str, str] = {}
        if authorization and authorization.strip():
            headers["Authorization"] = authorization.strip()
        # every call is for an AI tool: k8s-service lists the cluster requests it makes, with their Audit-IDs
        headers[RECORD_HEADER] = "1"
        # Multi-cluster (step 14): a client-level param adds ?cluster= to every
        # call so k8s-service (step 05) targets the selected cluster; merged
        # with any per-request params. The connection pool is shared, only the
        # user's headers and params belong to this instance.
        params = {"cluster": cluster_name} if cluster_name else None
        self.client = ScopedClient(self.base_url, timeout=30.0, headers=headers, params=params, on_response=self._note_access)
        # The identity the last cluster request went out as (k8s-service's X-Kubeast-Access), for the AI tool
        # call it served (app/services/ai/access.py).
        self.last_access: Optional[Dict] = None
        # The cluster requests since the tool began ({requests, total}), across its k8s-service calls.
        self.last_requests: Optional[Dict] = None

    def _note_access(self, response) -> None:
        access = from_header(response.headers.get(ACCESS_HEADER))
        if access is not None:
            self.last_access = access
        self.last_requests = merge(self.last_requests, trail_from_header(response.headers.get(REQUESTS_HEADER)))

    async def get_current_cluster(self) -> str:
        """The cluster k8s-service targets for this client (its default when none is named)."""
        response = await self.client.get("/current")
        response.raise_for_status()
        return response.json()["id"]

    async def get_features(self) -> Dict:
        """What this cluster can serve (prometheus, logSearch, cost, …) — k8s-service GET /features."""
        response = await self.client.get("/features")
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {}

    async def get_namespaces(self) -> List[Dict]:
        """네임스페이스 목록 조회"""
        response = await self.client.get("/namespaces")
        response.raise_for_status()
        return response.json()

    async def get_pod_page(self, **params: object) -> Dict:
        """One page of the Pods list (k8s-service GET /pods/page: q, match, sort, namespace, offset, limit, …),
        from the pod rows k8s-service keeps, as the caller."""
        response = await self.client.get("/pods/page", params={k: v for k, v in params.items() if v not in (None, "")})
        response.raise_for_status()
        return response.json()

    async def get_pods(self, namespace: str) -> List[Dict]:
        """특정 네임스페이스의 Pod 목록 조회"""
        response = await self.client.get(f"/namespaces/{_seg(namespace)}/pods")
        response.raise_for_status()
        return response.json()

    async def get_services(self, namespace: str) -> List[Dict]:
        """Service 목록 조회"""
        response = await self.client.get(f"/namespaces/{_seg(namespace)}/services")
        response.raise_for_status()
        return response.json()

    async def get_resources(
        self,
        resource_type: str,
        resource_name: Optional[str] = None,
        namespace: Optional[str] = None,
        all_namespaces: Optional[bool] = None,
        output: Optional[str] = None,
    ) -> Dict:
        """리소스 조회 (kubectl get 유사)"""
        params: Dict[str, object] = {"resource_type": resource_type}
        if resource_name:
            params["resource_name"] = resource_name
        if namespace:
            params["namespace"] = namespace
        if all_namespaces is not None:
            params["all_namespaces"] = str(all_namespaces).lower()
        if output:
            params["output"] = output

        response = await self.client.get("/resources", params=params)
        response.raise_for_status()
        return response.json()

    async def get_optimization(self, namespace: str, window_hours: Optional[int] = None) -> Dict:
        """네임스페이스 워크로드의 requests/limits 대비 사용량 표 (k8s-service가 계산)"""
        params: Dict[str, object] = {"namespace": namespace}
        if window_hours:
            params["window"] = window_hours
        response = await self.client.get("/optimization", params=params)
        response.raise_for_status()
        return response.json()
