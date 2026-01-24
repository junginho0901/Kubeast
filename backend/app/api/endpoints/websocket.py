"""
WebSocket 실시간 통신 API
"""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from typing import Dict, Set
import asyncio
import json
from app.services.k8s_service import K8sService

router = APIRouter()
k8s_service = K8sService()

# 연결된 클라이언트 관리
active_connections: Set[WebSocket] = set()


@router.websocket("/cluster-events")
async def websocket_cluster_events(websocket: WebSocket):
    """
    클러스터 이벤트 실시간 스트리밍
    """
    await websocket.accept()
    active_connections.add(websocket)
    
    try:
        while True:
            # 클라이언트로부터 메시지 수신 (heartbeat 등)
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=1.0)
                message = json.loads(data)
                
                if message.get("type") == "subscribe":
                    namespace = message.get("namespace", "default")
                    # 특정 네임스페이스 이벤트 구독
                    await websocket.send_json({
                        "type": "subscribed",
                        "namespace": namespace
                    })
                    
            except asyncio.TimeoutError:
                # 타임아웃은 정상 (이벤트 체크를 위해)
                pass
            
            # 주기적으로 클러스터 이벤트 체크 및 전송
            # TODO: Kubernetes Watch API 사용하여 실시간 이벤트 감지
            await asyncio.sleep(5)
            
    except WebSocketDisconnect:
        active_connections.remove(websocket)
    except Exception as e:
        print(f"WebSocket error: {e}")
        if websocket in active_connections:
            active_connections.remove(websocket)


@router.websocket("/pod-logs/{namespace}/{pod_name}")
async def websocket_pod_logs(websocket: WebSocket, namespace: str, pod_name: str):
    """
    파드 로그 실시간 스트리밍
    """
    await websocket.accept()
    
    try:
        # TODO: Kubernetes logs streaming 구현
        while True:
            logs = await k8s_service.get_pod_logs(namespace, pod_name, tail_lines=10)
            await websocket.send_json({
                "type": "logs",
                "data": logs
            })
            await asyncio.sleep(2)
            
    except WebSocketDisconnect:
        pass
    except Exception as e:
        await websocket.send_json({
            "type": "error",
            "message": str(e)
        })


async def broadcast_event(event: Dict):
    """모든 연결된 클라이언트에게 이벤트 브로드캐스트"""
    disconnected = set()
    for connection in active_connections:
        try:
            await connection.send_json(event)
        except Exception:
            disconnected.add(connection)
    
    # 연결 끊긴 클라이언트 제거
    active_connections.difference_update(disconnected)
