"""
AI Service API 라우터
"""
from fastapi import APIRouter, Header, HTTPException, Depends, Query
from fastapi.responses import StreamingResponse
from app.models.ai import ChatRequest
from app.security import require_auth

router = APIRouter()


def _require_admin(payload):
    if hasattr(payload, "has_permission") and payload.permissions:
        if not payload.has_permission("admin.ai_models.*"):
            raise HTTPException(status_code=403, detail="Permission denied")
        return
    role = (getattr(payload, "role", "") or "").lower()
    if role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

# K8s Service URL
K8S_SERVICE_URL = "http://k8s-service:8002/api/v1"
SESSION_SERVICE_URL = "http://session-service:8003/api/v1"

# ── Singleton AIService — reuse client/connection pool across requests ──
_cached_ai_config_hash: str = ""
_cached_ai_service = None  # Optional[AIService]


def _invalidate_caches():
    """Invalidate model config cache + singleton AIService after CRUD."""
    global _cached_ai_config_hash, _cached_ai_service
    from app.services.model_config_service import invalidate_model_config_cache
    invalidate_model_config_cache()
    _cached_ai_config_hash = ""
    _cached_ai_service = None


async def _build_ai_service(authorization: str):
    """
    Return an AIService that reuses the LLM client if the active model
    config hasn't changed.  Only *role / authorization* differs per user,
    so the heavy LLM client is shared while role-dependent parts
    (tool_server URL) are resolved per call.
    """
    global _cached_ai_config_hash, _cached_ai_service

    from app.services.model_config_service import resolve_model_config
    from app.services.ai_service import AIService

    resolved = await resolve_model_config()

    # Compute a cheap identity hash for the resolved config
    config_hash = f"{resolved.provider}|{resolved.model}|{resolved.base_url}|{resolved.api_key[:8] if resolved.api_key else ''}"

    if _cached_ai_service is not None and config_hash == _cached_ai_config_hash:
        # Reuse existing LLM client, only update per-request fields
        _cached_ai_service.update_authorization(authorization)
        return _cached_ai_service

    # Config changed or first call — create a new AIService
    service = AIService(
        authorization=authorization,
        provider=resolved.provider,
        model=resolved.model,
        base_url=resolved.base_url,
        api_key=resolved.api_key,
        extra_headers=resolved.extra_headers,
        tls_verify=resolved.tls_verify,
    )
    _cached_ai_service = service
    _cached_ai_config_hash = config_hash
    return service


@router.post("/chat/stream")
async def chat_stream(request: ChatRequest, authorization: str = Header(..., alias="Authorization")):
    """
    AI 챗봇 스트리밍
    """
    ai_service = await _build_ai_service(authorization)
    
    try:
        return StreamingResponse(
            ai_service.chat_stream(request),
            media_type="text/event-stream",
            headers={
                "X-Accel-Buffering": "no",
                "Cache-Control": "no-cache, no-transform",
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sessions/{session_id}/chat")
async def session_chat(session_id: str, message: str, authorization: str = Header(..., alias="Authorization")):
    """
    세션 기반 AI 챗봇 (스트리밍)
    """
    from app.database import get_db_service

    ai_service = await _build_ai_service(authorization)

    try:
        return StreamingResponse(
            ai_service.session_chat_stream(session_id, message),
            media_type="text/event-stream",
            headers={
                "X-Accel-Buffering": "no",
                "Cache-Control": "no-cache, no-transform",
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/analyze-logs")
async def analyze_logs(request: dict, authorization: str = Header(..., alias="Authorization")):
    """로그 분석"""
    ai_service = await _build_ai_service(authorization)
    
    try:
        from app.ai import LogAnalysisRequest
        req = LogAnalysisRequest(**request)
        result = await ai_service.analyze_logs(req)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/troubleshoot")
async def troubleshoot(request: dict, authorization: str = Header(..., alias="Authorization")):
    """트러블슈팅"""
    ai_service = await _build_ai_service(authorization)
    
    try:
        from app.ai import TroubleshootRequest
        req = TroubleshootRequest(**request)
        result = await ai_service.troubleshoot(req)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/explain-resource")
async def explain_resource(resource_type: str, resource_yaml: str, authorization: str = Header(..., alias="Authorization")):
    """리소스 YAML 설명"""
    ai_service = await _build_ai_service(authorization)
    
    try:
        explanation = await ai_service.explain_resource(resource_type, resource_yaml)
        return {"explanation": explanation}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/suggest-optimization")
async def suggest_optimization(namespace: str, authorization: str = Header(..., alias="Authorization")):
    """리소스 최적화 제안"""
    ai_service = await _build_ai_service(authorization)
    
    try:
        suggestions = await ai_service.suggest_optimization(namespace)
        return {"suggestions": suggestions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/suggest-optimization/stream")
async def suggest_optimization_stream(namespace: str, authorization: str = Header(..., alias="Authorization")):
    """리소스 최적화 제안 (SSE 스트리밍)"""
    ai_service = await _build_ai_service(authorization)

    try:
        return StreamingResponse(
            ai_service.suggest_optimization_stream(namespace),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/config")
async def get_config():
    """AI 서비스 설정 정보 조회"""
    from app.config import settings
    from app.services.model_config_service import resolve_model_config
    
    resolved = await resolve_model_config()
    return {
        "model": resolved.model,
        "app_name": settings.APP_NAME,
        "version": settings.APP_VERSION
    }


# ===== Model Configs (DB 기반) =====
@router.get("/model-configs", response_model=list)
async def list_model_configs(
    enabled_only: bool = Query(False),
    payload=Depends(require_auth),
):
    from app.database import get_db_service
    from app.models.model_config import ModelConfigResponse

    _require_admin(payload)

    db = await get_db_service()
    configs = await db.list_model_configs(enabled_only=enabled_only)
    return [ModelConfigResponse.model_validate(c) for c in configs]


@router.get("/model-configs/active")
async def get_active_model_config(payload=Depends(require_auth)):
    from app.database import get_db_service
    from app.models.model_config import ModelConfigResponse

    _require_admin(payload)

    db = await get_db_service()
    config = await db.get_active_model_config()
    return ModelConfigResponse.model_validate(config) if config else None


@router.post("/model-configs")
async def create_model_config(payload=Depends(require_auth), request: dict = None):
    from app.database import get_db_service
    from app.models.model_config import ModelConfigCreate, ModelConfigResponse

    _require_admin(payload)

    data = ModelConfigCreate(**(request or {})).model_dump(exclude_unset=True)
    db = await get_db_service()
    try:
        config = await db.create_model_config(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _invalidate_caches()
    return ModelConfigResponse.model_validate(config)


# NOTE: test_model_connection has been moved to public_router (no auth required).
# See main.py for registration.


@router.patch("/model-configs/{config_id}")
async def update_model_config(config_id: int, payload=Depends(require_auth), request: dict = None):
    from app.database import get_db_service
    from app.models.model_config import ModelConfigUpdate, ModelConfigResponse

    _require_admin(payload)

    data = ModelConfigUpdate(**(request or {})).model_dump(exclude_unset=True)
    db = await get_db_service()
    config = await db.update_model_config(config_id, data)
    if not config:
        raise HTTPException(status_code=404, detail="Model config not found")
    _invalidate_caches()
    return ModelConfigResponse.model_validate(config)


@router.delete("/model-configs/{config_id}", status_code=204)
async def delete_model_config(config_id: int, payload=Depends(require_auth)):
    from app.database import get_db_service

    _require_admin(payload)

    db = await get_db_service()
    ok = await db.delete_model_config(config_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Model config not found")
    _invalidate_caches()