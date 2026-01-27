"""
AI Service 모델
"""
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from enum import Enum


class SeverityLevel(str, Enum):
    """심각도 레벨"""
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


class LogAnalysisRequest(BaseModel):
    """로그 분석 요청"""
    logs: str
    namespace: str
    pod_name: str
    container: Optional[str] = None
    context: Optional[str] = None


class ErrorPattern(BaseModel):
    """감지된 에러 패턴"""
    pattern: str
    severity: SeverityLevel
    occurrences: int
    first_seen: Optional[str] = None
    last_seen: Optional[str] = None


class LogAnalysisResponse(BaseModel):
    """로그 분석 응답"""
    summary: str
    errors: List[ErrorPattern]
    root_cause: Optional[str] = None
    recommendations: List[str]
    related_issues: List[str] = []


class TroubleshootRequest(BaseModel):
    """트러블슈팅 요청"""
    namespace: str
    resource_type: str
    resource_name: str
    include_logs: bool = True
    include_events: bool = True


class TroubleshootResponse(BaseModel):
    """트러블슈팅 응답"""
    diagnosis: str
    severity: SeverityLevel
    root_causes: List[str]
    solutions: List[Dict[str, Any]]
    preventive_measures: List[str]
    estimated_fix_time: Optional[str] = None


class ChatMessage(BaseModel):
    """챗 메시지"""
    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    """챗 요청"""
    messages: List[ChatMessage]
    context: Optional[Dict[str, Any]] = None


class ChatResponse(BaseModel):
    """챗 응답"""
    message: str
    suggestions: List[str] = []
    actions: List[Dict[str, Any]] = []
