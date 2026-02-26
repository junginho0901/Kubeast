"""
Kubernetes 클러스터 리소스 모델
"""
from pydantic import BaseModel
from typing import List, Dict, Optional, Any
from datetime import datetime


class NamespaceInfo(BaseModel):
    """네임스페이스 정보"""
    name: str
    status: str
    created_at: datetime
    labels: Dict[str, str] = {}
    resource_count: Dict[str, int] = {}


class ServiceInfo(BaseModel):
    """서비스 정보"""
    name: str
    namespace: str
    type: str
    cluster_ip: Optional[str]
    external_ip: Optional[str]
    ports: List[Dict[str, Any]]
    selector: Dict[str, str] = {}
    created_at: datetime


class DeploymentInfo(BaseModel):
    """디플로이먼트 정보"""
    name: str
    namespace: str
    replicas: int
    ready_replicas: int
    available_replicas: int
    updated_replicas: int
    image: str
    labels: Dict[str, str] = {}
    selector: Dict[str, str] = {}
    created_at: datetime
    status: str


class ReplicaSetInfo(BaseModel):
    """레플리카셋 정보"""
    name: str
    namespace: str
    replicas: int
    ready_replicas: int
    available_replicas: int
    image: str
    owner: Optional[str] = None
    labels: Dict[str, str] = {}
    selector: Dict[str, str] = {}
    created_at: datetime
    status: str


class HPAInfo(BaseModel):
    """HorizontalPodAutoscaler 정보"""
    name: str
    namespace: str
    target_ref: str
    min_replicas: Optional[int]
    max_replicas: int
    current_replicas: Optional[int]
    desired_replicas: Optional[int]
    metrics: List[Dict[str, Any]] = []
    conditions: List[Dict[str, Any]] = []
    last_scale_time: Optional[str] = None
    created_at: datetime


class PDBInfo(BaseModel):
    """PodDisruptionBudget 정보"""
    name: str
    namespace: str
    min_available: Optional[str] = None
    max_unavailable: Optional[str] = None
    current_healthy: int
    desired_healthy: int
    disruptions_allowed: int
    expected_pods: int
    selector: Dict[str, str] = {}
    created_at: datetime


class PodInfo(BaseModel):
    """파드 정보"""
    name: str
    namespace: str
    status: str
    phase: str
    status_reason: Optional[str] = None
    status_message: Optional[str] = None
    node_name: Optional[str]
    pod_ip: Optional[str]
    containers: List[Dict[str, Any]]
    init_containers: List[Dict[str, Any]] = []
    labels: Dict[str, str] = {}
    created_at: datetime
    restart_count: int
    ready: str


class PVCInfo(BaseModel):
    """PVC 정보"""
    name: str
    namespace: str
    status: str
    volume_name: Optional[str]
    storage_class: Optional[str]
    capacity: Optional[str]
    requested: Optional[str]
    access_modes: List[str]
    created_at: datetime


class PVInfo(BaseModel):
    """PV 정보"""
    name: str
    status: str
    capacity: str
    access_modes: List[str]
    storage_class: Optional[str]
    reclaim_policy: str
    claim_ref: Optional[Dict[str, str]]
    volume_mode: Optional[str] = None
    source: Optional[str] = None
    driver: Optional[str] = None
    volume_handle: Optional[str] = None
    node_affinity: Optional[str] = None
    created_at: datetime


class ClusterOverview(BaseModel):
    """클러스터 전체 개요"""
    total_namespaces: int
    total_pods: int
    total_services: int
    total_deployments: int
    total_pvcs: int
    total_pvs: int
    pod_status: Dict[str, int] = {}
    node_count: int
    cluster_version: Optional[str]
