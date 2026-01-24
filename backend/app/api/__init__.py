"""
API 라우터
"""
from fastapi import APIRouter
from .endpoints import cluster, ai, topology, websocket, sessions

router = APIRouter()

# 각 엔드포인트 라우터 등록
router.include_router(cluster.router, prefix="/cluster", tags=["Cluster"])
router.include_router(ai.router, prefix="/ai", tags=["AI"])
router.include_router(topology.router, prefix="/topology", tags=["Topology"])
router.include_router(websocket.router, prefix="/ws", tags=["WebSocket"])
router.include_router(sessions.router, tags=["Sessions"])
