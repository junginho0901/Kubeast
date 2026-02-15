"""
Auth Service - IAM/인증 전담
Port: 8004
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api import router
from app.config import settings
import uvicorn

app = FastAPI(
    title="Auth Service",
    version="1.0.0",
    description="계정/토큰 발급 및 인증 서비스 (RS256 + JWKS)"
)

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

app.include_router(router, prefix="/api/v1/auth")


@app.get("/")
async def root():
    return {"service": "auth-service", "version": "1.0.0", "status": "healthy"}


@app.get("/health")
async def health_check():
    from app.database import get_db_service
    db_status = "disconnected"
    try:
        db = await get_db_service()
        db_status = "connected"
    except Exception as e:
        db_status = f"error: {str(e)[:50]}"

    return {"status": "healthy" if db_status == "connected" else "degraded", "database": db_status}


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8004,
        reload=settings.DEBUG
    )
