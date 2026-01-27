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
    
    def __init__(self):
        self.base_url = K8S_SERVICE_URL
        self.client = httpx.AsyncClient(base_url=self.base_url, timeout=30.0)
    
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
    
    async def get_pod_logs(self, namespace: str, pod_name: str, tail_lines: int = 100) -> str:
        """Pod 로그 조회"""
        response = await self.client.get(
            f"/namespaces/{namespace}/pods/{pod_name}/logs",
            params={"tail_lines": tail_lines}
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
    
    async def get_events(self, namespace: str) -> List[Dict]:
        """이벤트 조회"""
        response = await self.client.get(f"/namespaces/{namespace}/events")
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
