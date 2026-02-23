"""
애플리케이션 설정
"""
from pydantic_settings import BaseSettings
from typing import List
import os
from pathlib import Path


# 프로젝트 루트 디렉토리 찾기
def find_project_root():
    """프로젝트 루트 디렉토리 찾기 (.env 파일이 있는 곳)"""
    current = Path(__file__).resolve()
    # backend/app/config.py -> backend/app -> backend -> root
    for parent in current.parents:
        if (parent / ".env").exists():
            return parent
    # .env 파일이 없으면 backend의 부모 디렉토리 반환
    return current.parents[2]  # backend/app/config.py의 3단계 위


PROJECT_ROOT = find_project_root()


class Settings(BaseSettings):
    """애플리케이션 설정"""
    
    # App
    APP_NAME: str = "K8s DevOps Assistant"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = True
    
    # OpenAI
    OPENAI_API_KEY: str = ""  # 선택적으로 변경 (AI 기능 사용시 필요)
    OPENAI_MODEL: str = "gpt-4-turbo-preview"
    # OpenAI-compatible gateway base URL (e.g. LiteLLM/OpenRouter/local vLLM). Empty means default OpenAI endpoint.
    OPENAI_BASE_URL: str = ""
    OPENAI_OPTIMIZATION_MAX_TOKENS: int = 1800
    
    # Kubernetes
    KUBECONFIG_PATH: str = ""
    IN_CLUSTER: bool = False
    
    # CORS
    ALLOWED_ORIGINS: str = "http://localhost:3000,http://localhost:5173"
    
    @property
    def allowed_origins_list(self) -> List[str]:
        """ALLOWED_ORIGINS를 리스트로 변환"""
        return [origin.strip() for origin in self.ALLOWED_ORIGINS.split(",")]
    
    # Redis (Optional)
    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = 6379
    REDIS_DB: int = 0
    
    # WebSocket
    WS_HEARTBEAT_INTERVAL: int = 30
    
    class Config:
        # 프로젝트 루트의 .env 파일 사용
        env_file = str(PROJECT_ROOT / ".env")
        case_sensitive = True


settings = Settings()
