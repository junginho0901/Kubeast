"""
K8s DevOps Assistant - Main Application
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
from app.api import router
from app.config import settings

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="Kubernetes 클러스터 모니터링 및 AI 기반 트러블슈팅 플랫폼",
    docs_url="/docs",
    redoc_url="/redoc"
)

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API 라우터 등록
app.include_router(router, prefix="/api/v1")


@app.get("/")
async def root():
    """헬스 체크 엔드포인트"""
    return {
        "name": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "status": "healthy"
    }


@app.get("/health")
async def health_check():
    """상세 헬스 체크"""
    from app.services.k8s_service import K8sService
    
    # Kubernetes 연결 체크
    kubernetes_status = "disconnected"
    try:
        k8s_service = K8sService()
        # 간단한 API 호출로 연결 확인
        k8s_service.v1.list_namespace(limit=1)
        kubernetes_status = "connected"
    except Exception as e:
        kubernetes_status = f"error: {str(e)[:50]}"
    
    # OpenAI 설정 체크
    openai_status = "not_configured"
    if settings.OPENAI_API_KEY:
        openai_status = "configured"
    
    return {
        "status": "healthy" if kubernetes_status == "connected" else "degraded",
        "kubernetes": kubernetes_status,
        "openai": openai_status
    }


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.DEBUG
    )
