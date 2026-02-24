"""
K8s Service HTTP Client
MSA 환경에서 K8s Service와 HTTP로 통신
"""
import httpx
from typing import List, Optional, Dict
import json

K8S_SERVICE_URL = "http://k8s-service:8002/api/v1"


class K8sServiceClient:
    """K8s Service HTTP 클라이언트"""
    
    def __init__(self, authorization: Optional[str] = None):
        self.base_url = K8S_SERVICE_URL
        headers: Dict[str, str] = {}
        if authorization and authorization.strip():
            headers["Authorization"] = authorization.strip()
        self.client = httpx.AsyncClient(base_url=self.base_url, timeout=30.0, headers=headers)
    
    async def get_namespaces(self) -> List[Dict]:
        """네임스페이스 목록 조회"""
        response = await self.client.get("/namespaces")
        response.raise_for_status()
        return response.json()
    
    async def get_all_pods(self) -> List[Dict]:
        """전체 Pod 목록 조회"""
        response = await self.client.get("/pods/all")
        response.raise_for_status()
        return response.json()
    
    async def get_pods(self, namespace: str) -> List[Dict]:
        """특정 네임스페이스의 Pod 목록 조회"""
        response = await self.client.get(f"/namespaces/{namespace}/pods")
        response.raise_for_status()
        return response.json()
    
    async def describe_pod(self, namespace: str, name: str) -> Dict:
        """Pod 상세 정보 조회"""
        response = await self.client.get(f"/namespaces/{namespace}/pods/{name}/describe")
        response.raise_for_status()
        return response.json()
    
    async def get_pod_logs(
        self,
        namespace: str,
        pod_name: str,
        tail_lines: int = 100,
        container: Optional[str] = None,
    ) -> str:
        """Pod 로그 조회"""
        params: Dict[str, object] = {"tail_lines": tail_lines}
        if container:
            params["container"] = container

        response = await self.client.get(
            f"/namespaces/{namespace}/pods/{pod_name}/logs",
            params=params,
        )
        response.raise_for_status()
        data = response.json()
        return data.get("logs", "")
    
    async def get_deployments(self, namespace: str) -> List[Dict]:
        """Deployment 목록 조회"""
        response = await self.client.get(f"/namespaces/{namespace}/deployments")
        response.raise_for_status()
        return response.json()
    
    async def describe_deployment(self, namespace: str, name: str) -> Dict:
        """Deployment 상세 정보 조회"""
        response = await self.client.get(f"/namespaces/{namespace}/deployments/{name}/describe")
        response.raise_for_status()
        return response.json()
    
    async def get_services(self, namespace: str) -> List[Dict]:
        """Service 목록 조회"""
        response = await self.client.get(f"/namespaces/{namespace}/services")
        response.raise_for_status()
        return response.json()
    
    async def describe_service(self, namespace: str, name: str) -> Dict:
        """Service 상세 정보 조회"""
        response = await self.client.get(f"/namespaces/{namespace}/services/{name}/describe")
        response.raise_for_status()
        return response.json()

    async def check_service_connectivity(
        self,
        namespace: str,
        service_name: str,
        port: Optional[str] = None,
    ) -> Dict:
        """Service/Endpoint 연결성 확인"""
        params: Dict[str, object] = {}
        if port:
            params["port"] = port
        response = await self.client.get(
            f"/namespaces/{namespace}/services/{service_name}/connectivity",
            params=params,
        )
        response.raise_for_status()
        return response.json()
    
    async def get_events(self, namespace: Optional[str]) -> List[Dict]:
        """이벤트 조회"""
        if namespace:
            response = await self.client.get(f"/namespaces/{namespace}/events")
        else:
            response = await self.client.get("/events")
        response.raise_for_status()
        data = response.json()
        return data.get("events", [])
    
    async def get_node_list(self) -> List[Dict]:
        """노드 목록 조회"""
        response = await self.client.get("/nodes")
        response.raise_for_status()
        return response.json()
    
    async def describe_node(self, name: str) -> Dict:
        """노드 상세 정보 조회"""
        response = await self.client.get(f"/nodes/{name}/describe")
        response.raise_for_status()
        return response.json()
    
    async def get_pvcs(self, namespace: Optional[str] = None) -> List[Dict]:
        """PVC 목록 조회"""
        params = {"namespace": namespace} if namespace else {}
        response = await self.client.get("/pvcs", params=params)
        response.raise_for_status()
        return response.json()
    
    async def get_pvs(self) -> List[Dict]:
        """PV 목록 조회"""
        response = await self.client.get("/pvs")
        response.raise_for_status()
        return response.json()
    
    async def get_cluster_overview(self) -> Dict:
        """클러스터 전체 개요 조회"""
        response = await self.client.get("/overview")
        response.raise_for_status()
        return response.json()

    async def get_available_api_resources(self) -> List[Dict]:
        """API 리소스 목록 조회 (kubectl api-resources 유사)"""
        response = await self.client.get("/api-resources")
        response.raise_for_status()
        return response.json()

    async def get_cluster_configuration(self) -> Dict:
        """클러스터 구성 정보 조회 (kubectl config view 유사, 민감정보 제거)"""
        response = await self.client.get("/cluster-config")
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

    async def get_resource_yaml(
        self,
        resource_type: str,
        resource_name: str,
        namespace: Optional[str] = None,
    ) -> str:
        """리소스 YAML 조회"""
        params: Dict[str, object] = {
            "resource_type": resource_type,
            "resource_name": resource_name,
        }
        if namespace:
            params["namespace"] = namespace

        response = await self.client.get("/resources/yaml", params=params)
        response.raise_for_status()
        data = response.json()
        return data.get("yaml", "")

    async def describe_resource(
        self,
        resource_type: str,
        resource_name: str,
        namespace: Optional[str] = None,
    ) -> Dict:
        """리소스 상세 조회 (kubectl describe 유사)"""
        params: Dict[str, object] = {
            "resource_type": resource_type,
            "resource_name": resource_name,
        }
        if namespace:
            params["namespace"] = namespace

        response = await self.client.get("/resources/describe", params=params)
        response.raise_for_status()
        return response.json()
    
    async def get_pod_metrics(self, namespace: Optional[str] = None) -> List[Dict]:
        """Pod 리소스 사용량 조회"""
        params = {"namespace": namespace} if namespace else {}
        response = await self.client.get("/metrics/pods", params=params)
        response.raise_for_status()
        return response.json()
    
    async def get_node_metrics(self) -> List[Dict]:
        """노드 리소스 사용량 조회"""
        response = await self.client.get("/metrics/nodes")
        response.raise_for_status()
        return response.json()
