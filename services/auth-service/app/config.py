"""
애플리케이션 설정
"""
from pydantic_settings import BaseSettings
from typing import List
from pathlib import Path


def find_project_root():
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / ".env").exists():
            return parent
    return current.parents[2]


PROJECT_ROOT = find_project_root()


class Settings(BaseSettings):
    APP_NAME: str = "K8s DevOps Assistant"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = True

    ALLOWED_ORIGINS: str = "http://localhost:3000,http://localhost:5173"

    @property
    def allowed_origins_list(self) -> List[str]:
        return [origin.strip() for origin in self.ALLOWED_ORIGINS.split(",")]

    JWT_ISSUER: str = "kube-assistant-auth"
    JWT_AUDIENCE: str = "kube-assistant"
    JWT_EXPIRES_MINUTES: int = 10080  # 7 days

    # Bootstrap admin
    DEFAULT_ADMIN_EMAIL: str = "admin@local"
    DEFAULT_ADMIN_PASSWORD: str = "admin"
    DEFAULT_READ_EMAIL: str = "read@local"
    DEFAULT_READ_PASSWORD: str = "read"
    DEFAULT_WRITE_EMAIL: str = "write@local"
    DEFAULT_WRITE_PASSWORD: str = "write"

    # Key storage (dev)
    KEY_DIR: str = "/app/.keys"

    # Auth cookie (Argo CD style: HttpOnly cookie for browser streaming/WS)
    AUTH_COOKIE_NAME: str = "kube-assistant.token"

    # Cluster setup (bootstrap)
    SETUP_NAMESPACE: str = "kube-assistant"
    SETUP_KUBECONFIG_SECRET: str = "k8s-kubeconfig"
    SETUP_KUBECONFIG_PREFIX: str = "k8s-kubeconfig-"
    SETUP_CONFIGMAP_NAME: str = "kube-assistant-config"
    SETUP_RESTART_DEPLOYMENT: str = "k8s-service"

    class Config:
        env_file = str(PROJECT_ROOT / ".env")
        case_sensitive = True


settings = Settings()
