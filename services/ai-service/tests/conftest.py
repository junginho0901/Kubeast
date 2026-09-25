# pytest 전역 fixture — `app.config.settings` 모듈을 stub 으로 대체.
#
# 이유: 실제 `app.config.Settings` 는 BaseSettings (pydantic) 라 시스템
# 환경변수를 자동으로 읽어 들이는데, 사용자 OS 에 K8S_API_HOST / KEY_DIR /
# K8S_API_IP 같은 (Settings class 에 정의 안 된) 환경변수가 set 되어 있으면
# `extra_forbidden` 으로 import 자체가 실패함. test 는 환경 의존 없이 돌아야
# 하므로 sys.modules 에 fake module 주입.
#
# 주의: 이 stub 은 pytest 실행 시점에만 적용 (conftest.py 는 pytest 가 자동
# 로드). production 배포 / uvicorn 기동 시점엔 영향 없음.

import sys
from types import ModuleType


class _StubSettings:
    """필요한 attribute 만 정의 + getattr fallback 으로 None 반환."""

    OPENAI_OPTIMIZATION_MAX_TOKENS = 900
    OPENAI_API_KEY = "test"
    OPENAI_MODEL = "gpt-4"
    OPENAI_BASE_URL = ""
    DEBUG = False
    allowed_origins_list = ["http://localhost:5173"]

    def __getattr__(self, name):
        # 정의 안 된 settings.* 는 모두 None (or 0) — test 시 default fallback 작동
        return None


_stub_module = ModuleType("app.config")
_stub_module.settings = _StubSettings()
sys.modules["app.config"] = _stub_module
