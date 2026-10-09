"""
AI Service API 라우터
"""
import copy
import logging
from typing import Optional

import httpx

from fastapi import APIRouter, Header, HTTPException, Depends, Query, Request
from fastapi.responses import StreamingResponse
from app.models.ai import SessionChatRequest
from app.models.floating_ai import FloatingChatRequest
from pydantic import ValidationError
from app.security import require_auth, decode_access_token, bearer_or_cookie

logger = logging.getLogger(__name__)


def _validation_message(err: ValidationError) -> str:
    errors = err.errors()
    if not errors:
        return "invalid request"
    msg = str(errors[0].get("msg", "invalid request"))
    return msg[len("Value error, "):] if msg.startswith("Value error, ") else msg


def _extract_audit_meta(request: Request, authorization: str) -> tuple[dict, dict]:
    """authorization 토큰 + 요청 헤더에서 audit actor/http 메타 추출.

    실패해도 빈 dict 반환 — audit 는 best-effort.
    """
    actor: dict = {}
    try:
        token = authorization.split(" ", 1)[1] if " " in authorization else authorization
        payload = decode_access_token(token)
        actor = {"user_id": payload.user_id, "email": payload.email}
    except Exception:
        pass

    headers = request.headers
    # The client address the gateway attributed the request to (X-Real-IP).
    # X-Forwarded-For is not read: a client can put anything there.
    ip = headers.get("x-real-ip", "").strip() or (request.client.host if request.client else "")
    http = {
        "ip": ip,
        "user_agent": headers.get("user-agent", ""),
        "request_id": headers.get("x-request-id", ""),
        "path": str(request.url.path),
    }
    return actor, http


async def _authorize_session_access(authorization: str, session_id: str) -> None:
    """Verify the caller's JWT and that they own ``session_id`` (IDOR guard).

    The chat endpoints read/append messages and load conversation context for the
    session id taken straight from the URL. Without this check any authenticated
    (or even malformed-token) caller could read or inject into another user's
    session by guessing its id — ``_extract_audit_meta`` swallows bad tokens, so
    the per-request audit actor cannot be trusted as the gate. Here a bad token is
    a hard 401, and a session that is missing or owned by someone else is a 404
    (same response for both, so existence isn't leaked).
    """
    from app.database import get_db_service

    try:
        token = authorization.split(" ", 1)[1] if " " in authorization else authorization
        payload = decode_access_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")

    db = await get_db_service()
    session = await db.get_session(session_id)
    if session is None or session.user_id != payload.user_id:
        raise HTTPException(status_code=404, detail="Session not found")


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


async def _build_ai_service(authorization: str, cluster_name: Optional[str] = None):
    """
    Return an AIService that reuses the LLM client if the active model
    config hasn't changed.  Only *role / authorization / cluster* differ per
    user, so the heavy LLM client is shared while role-dependent parts
    (tool_server URL) and the active cluster are resolved per call.
    """
    global _cached_ai_config_hash, _cached_ai_service

    from app.services.model_config_service import resolve_model_config
    from app.services.ai_service import AIService

    resolved = await resolve_model_config()

    # Compute a cheap identity hash for the resolved config
    config_hash = (
        f"{resolved.provider}|{resolved.model}|{resolved.base_url}|"
        f"{resolved.api_key[:8] if resolved.api_key else ''}|"
        f"{resolved.tls_verify}|{bool(resolved.ca_cert)}|{resolved.options}"
    )

    if _cached_ai_service is None or config_hash != _cached_ai_config_hash:
        # Config changed or first call — build the LLM client once. The cached
        # instance carries no user: every request gets its own view below.
        _cached_ai_service = AIService(
            provider=resolved.provider,
            model=resolved.model,
            base_url=resolved.base_url,
            api_key=resolved.api_key,
            extra_headers=resolved.extra_headers,
            tls_verify=resolved.tls_verify,
            ca_cert=resolved.ca_cert,
            options=resolved.options,
        )
        _cached_ai_config_hash = config_hash

    # A request-scoped view: the LLM client, model and per-session tool
    # contexts are shared by reference; the user's token, role, cluster and
    # service clients live only on this copy. Mutating the shared instance
    # here would let a request that is still streaming pick up the next
    # request's user and cluster.
    if not cluster_name:
        # No X-Cluster-Name: take the cluster k8s-service resolves (its registry
        # default), so permissions, tool calls and audit rows name that one.
        from app.services.k8s_client import K8sServiceClient
        try:
            cluster_name = await K8sServiceClient(authorization=authorization).get_current_cluster()
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=_upstream_detail(e.response)) from e
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail="k8s-service unavailable") from e

    service = copy.copy(_cached_ai_service)
    service.update_authorization(authorization, cluster_name=cluster_name)
    return service


def _upstream_detail(response) -> str:
    try:
        return str(response.json().get("detail") or response.text)
    except ValueError:
        return response.text


@router.post("/sessions/{session_id}/chat")
async def session_chat(
    session_id: str,
    request: Request,
    body: SessionChatRequest,
    authorization: str = Depends(bearer_or_cookie),
    x_cluster_name: Optional[str] = Header(None, alias="X-Cluster-Name"),
):
    """
    세션 기반 AI 챗봇 (스트리밍)

    message 는 JSON body(`{"message": …}`)로만 받는다. 쿼리 파라미터로 받으면
    사용자가 쓴 문장(붙여 넣은 비밀 포함)이 게이트웨이·uvicorn 접근 로그에 그대로
    남으므로 `?message=` 는 더 받지 않는다(422).
    """
    from app.database import get_db_service

    message = body.message
    if not message.strip():
        raise HTTPException(status_code=422, detail="message required")

    await _authorize_session_access(authorization, session_id)
    ai_service = await _build_ai_service(authorization, cluster_name=x_cluster_name)
    audit_actor, audit_http = _extract_audit_meta(request, authorization)

    try:
        return StreamingResponse(
            ai_service.session_chat_stream(
                session_id,
                message,
                audit_actor=audit_actor,
                audit_http=audit_http,
            ),
            media_type="text/event-stream",
            headers={
                "X-Accel-Buffering": "no",
                "Cache-Control": "no-cache, no-transform",
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---- AI write-tool approvals (H2) ----
#
# The stream never executes a write tool. It records a pending approval and
# the user decides here. Only the requesting user can decide, within the TTL,
# and the tool runs with the arguments that were shown — never edited ones.

APPROVAL_RESULT_MAX_CHARS = 4000


def _approval_dict(a) -> dict:
    return {
        "id": a.id,
        "session_id": a.session_id,
        "cluster": a.cluster,
        "tool": a.tool,
        "args": a.args or {},
        "status": a.status,
        "result": a.result,
        "created_at": a.created_at.isoformat() + "Z" if a.created_at else None,
        "expires_at": a.expires_at.isoformat() + "Z" if a.expires_at else None,
        "decided_at": a.decided_at.isoformat() + "Z" if a.decided_at else None,
    }


def _caller(authorization: str):
    try:
        token = authorization.split(" ", 1)[1] if " " in authorization else authorization
        return decode_access_token(token)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")


async def _load_own_pending_approval(approval_id: str, payload):
    from app.database import get_db_service, utcnow

    db = await get_db_service()
    approval = await db.get_tool_approval(approval_id)
    if approval is None or approval.user_id != payload.user_id:
        raise HTTPException(status_code=404, detail="Approval not found")
    if approval.status == "pending" and approval.expires_at and approval.expires_at < utcnow():
        approval = await db.transition_tool_approval(approval.id, "pending", status="expired", decided_at=utcnow()) or await db.get_tool_approval(approval.id)
    if approval.status != "pending":
        raise HTTPException(status_code=409, detail=f"Approval is {approval.status}")
    return db, approval


@router.get("/tool-approvals")
async def list_tool_approvals(session_id: str, authorization: str = Depends(bearer_or_cookie)):
    from app.database import get_db_service

    payload = _caller(authorization)
    await _authorize_session_access(authorization, session_id)
    db = await get_db_service()
    rows = await db.list_tool_approvals(session_id, payload.user_id, pending_only=True)
    return [_approval_dict(a) for a in rows]


@router.get("/tool-approvals/{approval_id}")
async def get_tool_approval(approval_id: str, authorization: str = Depends(bearer_or_cookie)):
    from app.database import get_db_service

    payload = _caller(authorization)
    db = await get_db_service()
    approval = await db.get_tool_approval(approval_id)
    if approval is None or approval.user_id != payload.user_id:
        raise HTTPException(status_code=404, detail="Approval not found")
    return _approval_dict(approval)


@router.post("/tool-approvals/{approval_id}/reject")
async def reject_tool_approval(
    approval_id: str,
    request: Request,
    authorization: str = Depends(bearer_or_cookie),
):
    from app.database import utcnow
    from app.services.audit_writer import write_audit

    payload = _caller(authorization)
    db, approval = await _load_own_pending_approval(approval_id, payload)
    approval = await db.transition_tool_approval(approval.id, "pending", status="rejected", decided_at=utcnow())
    if approval is None:
        raise HTTPException(status_code=409, detail="Approval is no longer pending")
    await db.add_message(
        approval.session_id, "assistant",
        f"❌ `{approval.tool}` on `{approval.cluster}` was rejected by the user; nothing was changed.",
    )
    actor, http = _extract_audit_meta(request, authorization)
    await write_audit(
        action="ai.tool.reject", actor_user_id=actor.get("user_id"), actor_email=actor.get("email"), cluster=approval.cluster,
        target_type="tool", target_id=approval.tool,
        after={"approval_id": approval.id, "session_id": approval.session_id, "cluster": approval.cluster},
        request_ip=http.get("ip"), user_agent=http.get("user_agent"), request_id=http.get("request_id"), path=http.get("path"),
    )
    _invalidate_caches()
    return _approval_dict(approval)


@router.post("/tool-approvals/{approval_id}/approve")
async def approve_tool_approval(
    approval_id: str,
    request: Request,
    authorization: str = Depends(bearer_or_cookie),
):
    from app.database import utcnow
    from app.services.audit_writer import AuditUnavailable, fail_closed_enabled, require_audit_ready, write_audit
    from app.services.ai import formatters

    from app.services.approval_token import ApprovalTokenUnavailable, sign as sign_approval
    payload = _caller(authorization)
    db, approval = await _load_own_pending_approval(approval_id, payload)
    # The token binds the run to this approval's user, cluster, tool and
    # stored arguments; without the shared secret nothing can be approved.
    try:
        approval_token = sign_approval(approval.id, approval.user_id, approval.cluster, approval.tool, approval.args or {})
    except ApprovalTokenUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    # A write tool runs only when its audit rows can be stored (fail-closed):
    # checked before the approval leaves `pending`, so a refusal changes nothing.
    try:
        await require_audit_ready()
    except AuditUnavailable as e:
        # The reason names the database host; it stays in the log.
        logger.warning("audit: refusing unrecorded tool run (approval=%s tool=%s): %s", approval.id, approval.tool, e)
        raise HTTPException(status_code=503, detail="audit unavailable")
    # One statement moves pending → approved; a second click, or two clicks
    # racing, finds the row no longer pending and stops here.
    approval = await db.transition_tool_approval(approval.id, "pending", status="approved", decided_at=utcnow())
    if approval is None:
        raise HTTPException(status_code=409, detail="Approval is no longer pending")
    actor, http = _extract_audit_meta(request, authorization)
    stored = await write_audit(
        action="ai.tool.approve", actor_user_id=actor.get("user_id"), actor_email=actor.get("email"), cluster=approval.cluster,
        target_type="tool", target_id=approval.tool,
        after={"approval_id": approval.id, "session_id": approval.session_id, "cluster": approval.cluster},
        request_ip=http.get("ip"), user_agent=http.get("user_agent"), request_id=http.get("request_id"), path=http.get("path"),
    )
    if not stored and fail_closed_enabled():
        # The database went away between the readiness probe and the row: the
        # tool has not run, so close the approval instead of executing unrecorded.
        await db.transition_tool_approval(
            approval.id, "approved", status="failed", result="audit unavailable", decided_at=utcnow(),
        )
        _invalidate_caches()
        raise HTTPException(status_code=503, detail="audit unavailable")

    # Run with the stored arguments as the approving user: tool-server re-checks
    # ai.tool.<name> in the cluster (C1) and impersonates the user (C2).
    ai_service = await _build_ai_service(authorization, cluster_name=approval.cluster)
    args = dict(approval.args or {})
    status, error = "executed", None
    try:
        response = await ai_service._call_tool_server(approval.tool, args, approval_id=approval.id, approval_token=approval_token)
        formatted, _, _ = formatters._format_tool_result(approval.tool, args, response)
    except Exception as e:  # tool-server error (403 from the cluster, kubectl failure, ...)
        status, error = "failed", str(e)
        formatted = f"error: {error}"
    approval = await db.transition_tool_approval(
        approval.id, "approved", status=status, result=formatted[:APPROVAL_RESULT_MAX_CHARS], decided_at=utcnow(),
    ) or approval
    icon = "✅" if status == "executed" else "⚠️"
    await db.add_message(
        approval.session_id, "assistant",
        f"{icon} `{approval.tool}` on `{approval.cluster}` was approved and {'executed' if status == 'executed' else 'failed'}.\n\n```\n{approval.result}\n```",
        tool_calls=[{"function": approval.tool, "args": args, "result": approval.result, "approval_id": approval.id, "approval_status": status}],
    )
    await write_audit(
        action="ai.tool.call", actor_user_id=actor.get("user_id"), actor_email=actor.get("email"), cluster=approval.cluster,
        target_type=args.get("resource_type") or "tool",
        target_id=args.get("resource_name") or args.get("name") or approval.tool,
        namespace=args.get("namespace"),
        after={"approval_id": approval.id, "session_id": approval.session_id, "cluster": approval.cluster, "tool": approval.tool, "approved": True},
        request_ip=http.get("ip"), user_agent=http.get("user_agent"), request_id=http.get("request_id"), path=http.get("path"),
        result="success" if status == "executed" else "failure", error=error,
    )
    _invalidate_caches()
    return _approval_dict(approval)


@router.post("/sessions/{session_id}/floating-chat")
async def floating_session_chat(
    session_id: str,
    body: FloatingChatRequest,
    request: Request,
    authorization: str = Depends(bearer_or_cookie),
    x_cluster_name: Optional[str] = Header(None, alias="X-Cluster-Name"),
):
    """플로팅 AI 위젯 전용 세션 채팅.

    기존 ``/sessions/{id}/chat`` 과 분리된 JSON body 방식 엔드포인트:

    - 세션 자체(생성/목록/히스토리) 는 session-service `/api/v1/sessions` 공유
    - message + 화면 스냅샷(page_context) 을 JSON body 로 전달
    - AIService 확장점으로 플로팅 전용 시스템 프롬프트 / READONLY tool / page_context
      / 세션 제목 prefix 를 주입, 나머지 동작은 AIService 가 그대로 수행
    """
    from app.services.floating_ai_service import FloatingAIService

    await _authorize_session_access(authorization, session_id)
    # step 14: the underlying AIService is cluster-scoped too (tool calls), not
    # just the floating prompt text.
    ai_service = await _build_ai_service(authorization, cluster_name=x_cluster_name)
    floating_service = FloatingAIService(ai_service=ai_service)
    audit_actor, audit_http = _extract_audit_meta(request, authorization)

    try:
        return StreamingResponse(
            floating_service.session_chat_stream(
                session_id=session_id,
                message=body.message,
                page_context=body.page_context,
                cluster_name=x_cluster_name,
                audit_actor=audit_actor,
                audit_http=audit_http,
            ),
            media_type="text/event-stream",
            headers={
                "X-Accel-Buffering": "no",
                "Cache-Control": "no-cache, no-transform",
            },
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/suggest-optimization/stream")
async def suggest_optimization_stream(
    request: Request,
    namespace: str,
    authorization: str = Depends(bearer_or_cookie),
    x_cluster_name: Optional[str] = Header(None, alias="X-Cluster-Name"),
):
    """리소스 최적화 제안 (SSE 스트리밍)"""
    ai_service = await _build_ai_service(authorization, cluster_name=x_cluster_name)
    actor, http = _extract_audit_meta(request, authorization)

    try:
        return StreamingResponse(
            ai_service.suggest_optimization_stream(namespace, audit_actor=actor, audit_http=http),
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

    try:
        data = ModelConfigCreate(**(request or {})).model_dump(exclude_unset=True)
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=_validation_message(e))
    _check_model_config_policy(data)
    db = await get_db_service()
    try:
        config = await db.create_model_config(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _invalidate_caches()
    return ModelConfigResponse.model_validate(config)


def _check_model_config_policy(data: dict) -> None:
    """Where the key may come from, where it may go, what rides along
    (app.services.model_config_policy) — before anything is stored."""
    from app.services import model_config_policy

    try:
        model_config_policy.check_api_key_env(data.get("api_key_env"))
        model_config_policy.check_api_key_env(data.get("api_key_secret_key"))
        model_config_policy.check_base_url(data.get("base_url"))
        model_config_policy.check_extra_headers(data.get("extra_headers"))
    except model_config_policy.PolicyError as e:
        raise HTTPException(status_code=400, detail=str(e))


# NOTE: test_model_connection has been moved to public_router (no auth required).
# See main.py for registration.


@router.patch("/model-configs/{config_id}")
async def update_model_config(config_id: int, payload=Depends(require_auth), request: dict = None):
    from app.database import get_db_service
    from app.models.model_config import ModelConfigUpdate, ModelConfigResponse

    _require_admin(payload)

    try:
        data = ModelConfigUpdate(**(request or {})).model_dump(exclude_unset=True)
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=_validation_message(e))
    _check_model_config_policy(data)
    db = await get_db_service()
    if data.get("extra_headers"):
        # Responses mask header values; a client echoing them back keeps the
        # stored value instead of overwriting it with the mask.
        from app.services.model_config_policy import MASK

        current = await db.get_model_config(config_id)
        stored = (current.extra_headers or {}) if current else {}
        data["extra_headers"] = {k: (stored.get(k, v) if v == MASK else v) for k, v in data["extra_headers"].items()}
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