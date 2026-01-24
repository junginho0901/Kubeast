"""
리소스 토폴로지 API
"""
from fastapi import APIRouter, HTTPException
from app.services.topology_service import TopologyService
from app.models.topology import TopologyGraph

router = APIRouter()
topology_service = TopologyService()


@router.get("/namespace/{namespace}", response_model=TopologyGraph)
async def get_namespace_topology(namespace: str):
    """
    네임스페이스 전체 리소스 관계도
    - Service → Deployment → Pod
    - PVC → PV
    - ConfigMap, Secret 연결
    """
    try:
        return await topology_service.get_namespace_topology(namespace)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/service/{namespace}/{service_name}", response_model=TopologyGraph)
async def get_service_topology(namespace: str, service_name: str):
    """
    특정 서비스의 리소스 관계도
    """
    try:
        return await topology_service.get_service_topology(namespace, service_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/deployment/{namespace}/{deployment_name}", response_model=TopologyGraph)
async def get_deployment_topology(namespace: str, deployment_name: str):
    """
    특정 디플로이먼트의 리소스 관계도
    """
    try:
        return await topology_service.get_deployment_topology(namespace, deployment_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/storage", response_model=TopologyGraph)
async def get_storage_topology():
    """
    스토리지 리소스 관계도 (PV, PVC)
    """
    try:
        return await topology_service.get_storage_topology()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
