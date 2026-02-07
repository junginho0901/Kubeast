"""
K8s Service - Kubernetes 클러스터 전담
Port: 8002
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api import router
from app.config import settings
import uvicorn

app = FastAPI(
    title="K8s Service",
    version="1.0.0",
    description="Kubernetes 클러스터 관리 서비스"
)

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API 라우터 등록
app.include_router(router, prefix="/api/v1")


@app.middleware("http")
async def auth_middleware(request, call_next):
    # 헬스체크/프론트 리소스는 제외
    path = request.url.path
    if path in ["/", "/health"] or not path.startswith("/api/"):
        return await call_next(request)

    # CORS preflight 허용
    if request.method == "OPTIONS":
        return await call_next(request)

    # WebSocket 경로는 ASGI websocket 타입으로 들어오므로 여기서 처리하지 않음
    auth = request.headers.get("Authorization", "")
    if not auth:
        from starlette.responses import JSONResponse

        return JSONResponse({"detail": "Missing Authorization header"}, status_code=401)

    parts = auth.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        from starlette.responses import JSONResponse

        return JSONResponse({"detail": "Invalid Authorization header"}, status_code=401)

    token = parts[1].strip()
    try:
        from app.security import decode_access_token

        payload = decode_access_token(token)
        request.state.member_id = payload.member_id
        request.state.role = payload.role
    except Exception as e:
        from starlette.responses import JSONResponse

        detail = getattr(e, "detail", "Invalid token")
        status = getattr(e, "status_code", 401)
        return JSONResponse({"detail": detail}, status_code=status)

    return await call_next(request)


@app.get("/")
async def root():
    """헬스 체크"""
    return {
        "service": "k8s-service",
        "version": "1.0.0",
        "status": "healthy"
    }


@app.get("/health")
async def health_check():
    """상세 헬스 체크"""
    from app.services.k8s_service import K8sService
    
    kubernetes_status = "disconnected"
    try:
        k8s_service = K8sService()
        k8s_service.v1.list_namespace(limit=1)
        kubernetes_status = "connected"
    except Exception as e:
        kubernetes_status = f"error: {str(e)[:50]}"
    
    return {
        "status": "healthy" if kubernetes_status == "connected" else "degraded",
        "kubernetes": kubernetes_status
    }


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8002,
        reload=settings.DEBUG
    )
