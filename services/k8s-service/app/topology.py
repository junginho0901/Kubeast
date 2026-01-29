"""
토폴로지 모델
"""
from pydantic import BaseModel
from typing import List, Dict, Optional, Any
from enum import Enum


class NodeType(str, Enum):
    """노드 타입"""
    SERVICE = "service"
    DEPLOYMENT = "deployment"
    STATEFULSET = "statefulset"
    DAEMONSET = "daemonset"
    POD = "pod"
    PVC = "pvc"
    PV = "pv"
    CONFIGMAP = "configmap"
    SECRET = "secret"
    INGRESS = "ingress"


class EdgeType(str, Enum):
    """엣지 타입"""
    ROUTES_TO = "routes_to"
    MANAGES = "manages"
    USES = "uses"
    MOUNTS = "mounts"
    BOUND_TO = "bound_to"


class TopologyNode(BaseModel):
    """토폴로지 노드"""
    id: str
    type: NodeType
    name: str
    namespace: Optional[str]
    status: str
    metadata: Dict[str, Any] = {}
    position: Optional[Dict[str, float]] = None


class TopologyEdge(BaseModel):
    """토폴로지 엣지"""
    id: str
    source: str
    target: str
    type: EdgeType
    label: Optional[str] = None


class TopologyGraph(BaseModel):
    """토폴로지 그래프"""
    nodes: List[TopologyNode]
    edges: List[TopologyEdge]
    metadata: Dict[str, Any] = {}
