"""
AI 트러블슈팅 API
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from typing import List
from app.services.ai_service import AIService
from app.models.ai import (
    LogAnalysisRequest,
    LogAnalysisResponse,
    TroubleshootRequest,
    TroubleshootResponse,
    ChatRequest,
    ChatResponse,
    ChatMessage
)

router = APIRouter()
ai_service = AIService()


@router.post("/analyze-logs", response_model=LogAnalysisResponse)
async def analyze_logs(request: LogAnalysisRequest):
    """
    로그 분석
    - 에러 패턴 감지
    - 원인 분석
    - 해결 방안 제시
    """
    try:
        return await ai_service.analyze_logs(request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/troubleshoot", response_model=TroubleshootResponse)
async def troubleshoot(request: TroubleshootRequest):
    """
    종합 트러블슈팅
    - 리소스 상태 분석
    - 이벤트 분석
    - 로그 분석
    - 해결 방안 제시
    """
    try:
        return await ai_service.troubleshoot(request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    AI 챗봇 대화
    - 자연어로 클러스터 질의
    - 문제 해결 가이드
    - 베스트 프랙티스 추천
    """
    try:
        return await ai_service.chat(request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """
    AI 챗봇 대화 (스트리밍)
    - 실시간 응답 스트리밍
    """
    try:
        return StreamingResponse(
            ai_service.chat_stream(request),
            media_type="text/event-stream"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sessions/{session_id}/chat")
async def session_chat(session_id: str, message: str):
    """
    세션 기반 AI 챗봇 대화 (스트리밍)
    - 세션별 대화 히스토리 관리
    - Tool Context 유지
    """
    try:
        return StreamingResponse(
            ai_service.session_chat_stream(session_id, message),
            media_type="text/event-stream"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/explain-resource")
async def explain_resource(resource_type: str, resource_yaml: str):
    """
    리소스 YAML 설명
    - 리소스 구성 설명
    - 잠재적 문제점 지적
    - 개선 제안
    """
    try:
        explanation = await ai_service.explain_resource(resource_type, resource_yaml)
        return {"explanation": explanation}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/suggest-optimization")
async def suggest_optimization(namespace: str):
    """
    리소스 최적화 제안
    - CPU/Memory 사용률 분석
    - 리소스 제한 권장사항
    - 비용 절감 방안
    """
    try:
        suggestions = await ai_service.suggest_optimization(namespace)
        return {"suggestions": suggestions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
