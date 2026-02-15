"""
AI Service - OpenAI 통합 및 AI 기능 전담
Port: 8001
"""
from fastapi import FastAPI, HTTPException
from fastapi import Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from app.api import router
from app.config import settings
from app.security import require_auth
import uvicorn

app = FastAPI(
    title="AI Service",
    version="1.0.0",
    description="OpenAI 통합 및 AI 분석 서비스"
)

# CORS 설정
allowed_origins = settings.allowed_origins_list
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    # NOTE: allow_origins=["*"] 와 allow_credentials=True 조합은 브라우저에서 동작하지 않습니다.
    # env(ALLOWED_ORIGINS)에 "*"를 넣을 경우 credentials는 자동으로 끕니다.
    allow_credentials="*" not in allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API 라우터 등록
app.include_router(router, prefix="/api/v1/ai", dependencies=[Depends(require_auth)])


@app.get("/")
async def root():
    """헬스 체크"""
    return {
        "service": "ai-service",
        "version": "1.0.0",
        "status": "healthy"
    }


@app.get("/health")
async def health_check():
    """상세 헬스 체크"""
    openai_status = "configured" if settings.OPENAI_API_KEY else "not_configured"
    
    return {
        "status": "healthy",
        "openai": openai_status,
        "model": settings.OPENAI_MODEL
    }


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8001,
        reload=settings.DEBUG
    )
