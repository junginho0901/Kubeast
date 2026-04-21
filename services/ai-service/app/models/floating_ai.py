"""
플로팅 AI 어시스턴트 모델 (화면 인식 채팅)

기존 AIChat 페이지(`/ai-chat`) 와 분리된 플로팅 위젯이 현재 화면의 요약
스냅샷(page_context) 을 함께 전송하여 "이 화면 뭐야" 류 질문에 바로
답하기 위한 Pydantic 모델 정의.
"""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class VisibleDataLayer(BaseModel):
    """화면의 한 레이어 — 베이스 페이지 또는 오버레이(모달/드로어)."""

    source: str  # "base" | "ResourceDetailDrawer" | "YamlEditor" 등
    summary: str  # LLM 이 먼저 읽는 한 줄 요약
    data: Optional[Dict[str, Any]] = None  # 집계/top N/차트 통계 등 구조화된 데이터


class PageContextPayload(BaseModel):
    """플로팅 위젯이 질문과 함께 전송하는 페이지 컨텍스트."""

    page_type: str  # "dashboard" | "resource-list" | "topology" | "gpu" | ...
    page_title: str
    path: str
    resource_kind: Optional[str] = None
    namespace: Optional[str] = None
    cluster: Optional[str] = None  # 멀티클러스터 PR 에서 채워짐
    context_changed: bool = False  # 직전 질문 이후 페이지 이동 발생 여부
    snapshot_at: str  # ISO 8601
    base: Optional[VisibleDataLayer] = None
    overlays: List[VisibleDataLayer] = Field(default_factory=list)


class FloatingChatRequest(BaseModel):
    """POST /sessions/{session_id}/floating-chat 의 요청 body."""

    message: str
    page_context: Optional[PageContextPayload] = None
