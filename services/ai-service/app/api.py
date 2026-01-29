"""
AI Service API 라우터
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from typing import List
import httpx
from pydantic import BaseModel

router = APIRouter()

# K8s Service URL
K8S_SERVICE_URL = "http://k8s-service:8002/api/v1"
SESSION_SERVICE_URL = "http://session-service:8003/api/v1"


class ChatRequest(BaseModel):
    messages: List[dict]


@router.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """
    AI 챗봇 스트리밍
    """
    from app.services.ai_service import AIService
    
    ai_service = AIService()
    
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
    세션 기반 AI 챗봇 (스트리밍)
    """
    from app.services.ai_service import AIService
    from app.database import get_db_service
    
    ai_service = AIService()
    
    try:
        return StreamingResponse(
            ai_service.session_chat_stream(session_id, message),
            media_type="text/event-stream"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/analyze-logs")
async def analyze_logs(request: dict):
    """로그 분석"""
    from app.services.ai_service import AIService
    
    ai_service = AIService()
    
    try:
        from app.ai import LogAnalysisRequest
        req = LogAnalysisRequest(**request)
        result = await ai_service.analyze_logs(req)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/troubleshoot")
async def troubleshoot(request: dict):
    """트러블슈팅"""
    from app.services.ai_service import AIService
    
    ai_service = AIService()
    
    try:
        from app.ai import TroubleshootRequest
        req = TroubleshootRequest(**request)
        result = await ai_service.troubleshoot(req)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/explain-resource")
async def explain_resource(resource_type: str, resource_yaml: str):
    """리소스 YAML 설명"""
    from app.services.ai_service import AIService
    
    ai_service = AIService()
    
    try:
        explanation = await ai_service.explain_resource(resource_type, resource_yaml)
        return {"explanation": explanation}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/suggest-optimization")
async def suggest_optimization(namespace: str):
    """리소스 최적화 제안"""
    from app.services.ai_service import AIService
    
    ai_service = AIService()
    
    try:
        suggestions = await ai_service.suggest_optimization(namespace)
        return {"suggestions": suggestions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/config")
async def get_config():
    """AI 서비스 설정 정보 조회"""
    from app.config import settings
    
    return {
        "model": settings.OPENAI_MODEL,
        "app_name": settings.APP_NAME,
        "version": settings.APP_VERSION
    }
