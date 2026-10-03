"""
AI 서비스 모델
"""
from pydantic import BaseModel


class SessionChatRequest(BaseModel):
    """세션 챗 요청 — message 는 body 로(쿼리에 두면 접근 로그에 남는다)"""
    message: str
