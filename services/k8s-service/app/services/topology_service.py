"""
리소스 토폴로지 서비스
"""
from typing import List, Dict, Set
from app.topology import (
    TopologyGraph,
    TopologyNode,
    TopologyEdge,
    NodeType,
    EdgeType
)
from app.services.k8s_service import K8sService


class TopologyService:
    """리소스 토폴로지 서비스"""
    
    def __init__(self):
        self.k8s_service = K8sService()
    
    async def get_namespace_topology(self, namespace: str) -> TopologyGraph:
        """네임스페이스 전체 토폴로지"""
        nodes = []
        edges = []
        
        # Services
        services = await self.k8s_service.get_services(namespace)
        for svc in services:
            nodes.append(TopologyNode(
                id=f"svc-{svc.name}",
                type=NodeType.SERVICE,
                name=svc.name,
                namespace=namespace,
                status="Active",
                metadata={
                    "type": svc.type,
                    "cluster_ip": svc.cluster_ip,
                    "selector": svc.selector
                }
            ))
        
        # Deployments
        deployments = await self.k8s_service.get_deployments(namespace)
        for deploy in deployments:
            nodes.append(TopologyNode(
                id=f"deploy-{deploy.name}",
                type=NodeType.DEPLOYMENT,
                name=deploy.name,
                namespace=namespace,
                status=deploy.status,
                metadata={
                    "replicas": deploy.replicas,
                    "ready": deploy.ready_replicas,
                    "image": deploy.image
                }
            ))
            
            # Service -> Deployment 연결
            for svc in services:
                if self._selector_matches(svc.selector, deploy.labels):
                    edges.append(TopologyEdge(
                        id=f"svc-{svc.name}-to-deploy-{deploy.name}",
                        source=f"svc-{svc.name}",
                        target=f"deploy-{deploy.name}",
                        type=EdgeType.ROUTES_TO,
                        label="routes to"
                    ))
        
        # Pods
        pods = await self.k8s_service.get_pods(namespace)
        for pod in pods:
            nodes.append(TopologyNode(
                id=f"pod-{pod.name}",
                type=NodeType.POD,
                name=pod.name,
                namespace=namespace,
                status=pod.status,
                metadata={
                    "phase": pod.phase,
                    "node": pod.node_name,
                    "ip": pod.pod_ip
                }
            ))
            
            # Deployment -> Pod 연결
            for deploy in deployments:
                if self._selector_matches(deploy.selector, pod.labels):
                    edges.append(TopologyEdge(
                        id=f"deploy-{deploy.name}-to-pod-{pod.name}",
                        source=f"deploy-{deploy.name}",
                        target=f"pod-{pod.name}",
                        type=EdgeType.MANAGES,
                        label="manages"
                    ))
        
        # PVCs
        pvcs = await self.k8s_service.get_pvcs(namespace)
        for pvc in pvcs:
            nodes.append(TopologyNode(
                id=f"pvc-{pvc.name}",
                type=NodeType.PVC,
                name=pvc.name,
                namespace=namespace,
                status=pvc.status,
                metadata={
                    "capacity": pvc.capacity,
                    "storage_class": pvc.storage_class
                }
            ))
            
            # Pod -> PVC 연결 (실제로는 Pod의 볼륨 마운트 정보 필요)
            # 여기서는 간단히 처리
        
        return TopologyGraph(
            nodes=nodes,
            edges=edges,
            metadata={
                "namespace": namespace,
                "node_count": len(nodes),
                "edge_count": len(edges)
            }
        )
    
    async def get_service_topology(self, namespace: str, service_name: str) -> TopologyGraph:
        """특정 서비스의 토폴로지"""
        nodes = []
        edges = []
        
        # Service
        services = await self.k8s_service.get_services(namespace)
        service = next((s for s in services if s.name == service_name), None)
        
        if not service:
            return TopologyGraph(nodes=[], edges=[])
        
        nodes.append(TopologyNode(
            id=f"svc-{service.name}",
            type=NodeType.SERVICE,
            name=service.name,
            namespace=namespace,
            status="Active",
            metadata={"type": service.type, "selector": service.selector}
        ))
        
        # 연결된 Deployments와 Pods
        deployments = await self.k8s_service.get_deployments(namespace)
        pods = await self.k8s_service.get_pods(namespace)
        
        for deploy in deployments:
            if self._selector_matches(service.selector, deploy.labels):
                nodes.append(TopologyNode(
                    id=f"deploy-{deploy.name}",
                    type=NodeType.DEPLOYMENT,
                    name=deploy.name,
                    namespace=namespace,
                    status=deploy.status,
                    metadata={"replicas": deploy.replicas}
                ))
                
                edges.append(TopologyEdge(
                    id=f"svc-to-deploy-{deploy.name}",
                    source=f"svc-{service.name}",
                    target=f"deploy-{deploy.name}",
                    type=EdgeType.ROUTES_TO
                ))
                
                # Deployment의 Pods
                for pod in pods:
                    if self._selector_matches(deploy.selector, pod.labels):
                        nodes.append(TopologyNode(
                            id=f"pod-{pod.name}",
                            type=NodeType.POD,
                            name=pod.name,
                            namespace=namespace,
                            status=pod.status,
                            metadata={"phase": pod.phase}
                        ))
                        
                        edges.append(TopologyEdge(
                            id=f"deploy-to-pod-{pod.name}",
                            source=f"deploy-{deploy.name}",
                            target=f"pod-{pod.name}",
                            type=EdgeType.MANAGES
                        ))
        
        return TopologyGraph(nodes=nodes, edges=edges)
    
    async def get_deployment_topology(self, namespace: str, deployment_name: str) -> TopologyGraph:
        """특정 디플로이먼트의 토폴로지"""
        nodes = []
        edges = []
        
        deployments = await self.k8s_service.get_deployments(namespace)
        deployment = next((d for d in deployments if d.name == deployment_name), None)
        
        if not deployment:
            return TopologyGraph(nodes=[], edges=[])
        
        nodes.append(TopologyNode(
            id=f"deploy-{deployment.name}",
            type=NodeType.DEPLOYMENT,
            name=deployment.name,
            namespace=namespace,
            status=deployment.status,
            metadata={"replicas": deployment.replicas, "image": deployment.image}
        ))
        
        # Pods
        pods = await self.k8s_service.get_pods(namespace)
        for pod in pods:
            if self._selector_matches(deployment.selector, pod.labels):
                nodes.append(TopologyNode(
                    id=f"pod-{pod.name}",
                    type=NodeType.POD,
                    name=pod.name,
                    namespace=namespace,
                    status=pod.status,
                    metadata={"phase": pod.phase, "node": pod.node_name}
                ))
                
                edges.append(TopologyEdge(
                    id=f"deploy-to-pod-{pod.name}",
                    source=f"deploy-{deployment.name}",
                    target=f"pod-{pod.name}",
                    type=EdgeType.MANAGES
                ))
        
        return TopologyGraph(nodes=nodes, edges=edges)
    
    async def get_storage_topology(self) -> TopologyGraph:
        """스토리지 토폴로지"""
        nodes = []
        edges = []
        
        # PVs
        pvs = await self.k8s_service.get_pvs()
        for pv in pvs:
            nodes.append(TopologyNode(
                id=f"pv-{pv.name}",
                type=NodeType.PV,
                name=pv.name,
                namespace=None,
                status=pv.status,
                metadata={
                    "capacity": pv.capacity,
                    "storage_class": pv.storage_class,
                    "reclaim_policy": pv.reclaim_policy
                }
            ))
        
        # PVCs
        pvcs = await self.k8s_service.get_pvcs()
        for pvc in pvcs:
            nodes.append(TopologyNode(
                id=f"pvc-{pvc.namespace}-{pvc.name}",
                type=NodeType.PVC,
                name=pvc.name,
                namespace=pvc.namespace,
                status=pvc.status,
                metadata={
                    "capacity": pvc.capacity,
                    "storage_class": pvc.storage_class
                }
            ))
            
            # PVC -> PV 연결
            if pvc.volume_name:
                edges.append(TopologyEdge(
                    id=f"pvc-to-pv-{pvc.volume_name}",
                    source=f"pvc-{pvc.namespace}-{pvc.name}",
                    target=f"pv-{pvc.volume_name}",
                    type=EdgeType.BOUND_TO,
                    label="bound to"
                ))
        
        return TopologyGraph(nodes=nodes, edges=edges)
    
    def _selector_matches(self, selector: Dict[str, str], labels: Dict[str, str]) -> bool:
        """셀렉터가 라벨과 매치되는지 확인"""
        if not selector:
            return False
        
        for key, value in selector.items():
            if labels.get(key) != value:
                return False
        
        return True
