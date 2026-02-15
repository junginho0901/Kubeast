"""
Session Service - 채팅 세션 및 히스토리 관리
Port: 8003
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api import router
from app.config import settings
import uvicorn

app = FastAPI(
    title="Session Service",
    version="1.0.0",
    description="채팅 세션 및 메시지 히스토리 관리 서비스"
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
app.include_router(router, prefix="/api/v1")


@app.get("/")
async def root():
    """헬스 체크"""
    return {
        "service": "session-service",
        "version": "1.0.0",
        "status": "healthy"
    }


@app.get("/health")
async def health_check():
    """상세 헬스 체크"""
    from app.database import get_db_service
    
    db_status = "disconnected"
    try:
        db = await get_db_service()
        db_status = "connected"
    except Exception as e:
        db_status = f"error: {str(e)[:50]}"
    
    return {
        "status": "healthy" if db_status == "connected" else "degraded",
        "database": db_status
    }


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8003,
        reload=settings.DEBUG
    )
