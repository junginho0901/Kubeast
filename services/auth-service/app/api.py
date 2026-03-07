from fastapi import APIRouter, HTTPException, Depends, Query, Request, Header, Response
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import uuid
import json
import logging
import yaml

from app.database import get_db_service
from app.security import create_access_token, hash_password, jwks, require_auth, TokenPayload, verify_password
from app.k8s_setup import (
    upsert_kubeconfig_secret,
    patch_configmap,
    restart_deployment,
    get_kubeconfig_from_secret,
    delete_secret,
)
from app.config import settings

router = APIRouter()
audit_logger = logging.getLogger("auth.audit")
if not audit_logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    audit_logger.addHandler(handler)
audit_logger.setLevel(logging.INFO)
audit_logger.propagate = False

ALLOWED_ROLES = {"admin", "read", "write"}


def _normalize_role(role: str) -> str:
    value = (role or "").strip().lower()
    if value not in ALLOWED_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role: {role}. Allowed: {sorted(ALLOWED_ROLES)}")
    return value


def _require_admin(payload: TokenPayload):
    if (payload.role or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin only")


class UserResponse(BaseModel):
    id: str
    name: str
    email: str
    hq: Optional[str] = None
    team: Optional[str] = None
    role: str
    created_at: datetime
    updated_at: datetime


class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str
    hq: Optional[str] = None
    team: Optional[str] = None


class LoginRequest(BaseModel):
    email: str
    password: str


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


class UpdateUserRoleRequest(BaseModel):
    role: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ClusterSetupStatus(BaseModel):
    configured: bool
    mode: Optional[str] = None
    secret_name: Optional[str] = None


class ClusterSetupRequest(BaseModel):
    mode: str  # in_cluster | external
    kubeconfig: Optional[str] = None


class ClusterConnectionRequest(BaseModel):
    name: str
    mode: str  # in_cluster | external
    kubeconfig: Optional[str] = None


class ClusterConnectionUpdateRequest(BaseModel):
    name: str


class ClusterConnectionResponse(BaseModel):
    id: str
    name: str
    mode: str
    secret_name: Optional[str] = None
    is_active: bool = False
    created_at: datetime
    updated_at: datetime


@router.get("/jwks.json")
async def get_jwks():
    return jwks()


@router.get("/.well-known/jwks.json")
async def get_jwks_well_known():
    return jwks()


@router.post("/register", response_model=UserResponse)
async def register(request: RegisterRequest):
    email = (request.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email")
    if not request.password:
        raise HTTPException(status_code=400, detail="Password required")

    db = await get_db_service()
    existing = await db.get_user_by_email(email)
    if existing:
        raise HTTPException(status_code=409, detail="Email already exists")

    hq = (request.hq or "").strip() or None
    team = (request.team or "").strip() or None

    user_id = str(uuid.uuid4())
    user = await db.create_user(
        user_id=user_id,
        name=request.name.strip() or "user",
        email=email,
        password_hash=hash_password(request.password),
        role="read",
        hq=hq,
        team=team,
    )

    return UserResponse(
        id=user.id,
        name=user.name,
        email=user.email,
        hq=getattr(user, "hq", None),
        team=getattr(user, "team", None),
        role=user.role,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


@router.post("/login", response_model=AuthResponse)
async def login(request: LoginRequest, http_request: Request, response: Response):
    email = (request.email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Email required")

    db = await get_db_service()
    user = await db.get_user_by_email(email)
    if not user or not verify_password(request.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token(user_id=user.id, role=user.role)

    # Also issue JWT via HttpOnly cookie for browser WS/SSE streaming (Argo CD style).
    from app.config import settings

    forwarded_proto = (http_request.headers.get("X-Forwarded-Proto") or "").strip().lower()
    is_secure = forwarded_proto == "https"
    response.set_cookie(
        key=settings.AUTH_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=is_secure,
        samesite="lax",
        max_age=int(settings.JWT_EXPIRES_MINUTES) * 60,
        path="/",
    )

    return AuthResponse(
        access_token=token,
        user=UserResponse(
            id=user.id,
            name=user.name,
            email=user.email,
            hq=getattr(user, "hq", None),
            team=getattr(user, "team", None),
            role=user.role,
            created_at=user.created_at,
            updated_at=user.updated_at,
        ),
    )

@router.post("/logout")
async def logout(response: Response):
    """Clear auth cookie (best-effort)."""
    from app.config import settings

    response.delete_cookie(key=settings.AUTH_COOKIE_NAME, path="/")
    return {"success": True}


@router.get("/setup", response_model=ClusterSetupStatus)
async def get_setup_status():
    db = await get_db_service()
    setup = await db.get_cluster_setup()
    if not setup:
        return ClusterSetupStatus(configured=False)
    return ClusterSetupStatus(configured=True, mode=setup.mode, secret_name=setup.secret_name)


@router.post("/setup", response_model=ClusterSetupStatus)
async def setup_cluster(request: ClusterSetupRequest):
    mode = (request.mode or "").strip().lower()
    if mode not in {"in_cluster", "external"}:
        raise HTTPException(status_code=400, detail="Invalid mode. Use in_cluster or external.")

    db = await get_db_service()
    existing = await db.get_cluster_setup()
    if existing:
        raise HTTPException(status_code=409, detail="Cluster setup already completed.")

    kubeconfig_text = (request.kubeconfig or "").strip()
    if mode == "external":
        if not kubeconfig_text:
            raise HTTPException(status_code=400, detail="kubeconfig is required for external mode.")
        try:
            data = yaml.safe_load(kubeconfig_text) or {}
            if not data.get("clusters") or not data.get("users"):
                raise ValueError("missing clusters/users")
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid kubeconfig format.")
    else:
        kubeconfig_text = ""

    try:
        upsert_kubeconfig_secret(
            namespace=settings.SETUP_NAMESPACE,
            name=settings.SETUP_KUBECONFIG_SECRET,
            kubeconfig_text=kubeconfig_text,
        )
        patch_configmap(
            namespace=settings.SETUP_NAMESPACE,
            name=settings.SETUP_CONFIGMAP_NAME,
            data={
                "IN_CLUSTER": "true" if mode == "in_cluster" else "false",
                "KUBECONFIG_PATH": "/app/kubeconfig.yaml",
            },
        )
        restart_deployment(
            namespace=settings.SETUP_NAMESPACE,
            name=settings.SETUP_RESTART_DEPLOYMENT,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to apply cluster setup: {e}")

    setup = await db.set_cluster_setup(mode=mode, secret_name=settings.SETUP_KUBECONFIG_SECRET)
    return ClusterSetupStatus(configured=True, mode=setup.mode, secret_name=setup.secret_name)


@router.get("/cluster-connections", response_model=list[ClusterConnectionResponse])
async def list_cluster_connections(payload: TokenPayload = Depends(require_auth)):
    _require_admin(payload)
    db = await get_db_service()
    rows = await db.list_cluster_connections()
    if not rows:
        setup = await db.get_cluster_setup()
        if setup:
            connection_id = str(uuid.uuid4())
            row = await db.create_cluster_connection(
                connection_id=connection_id,
                name="Default cluster",
                mode=setup.mode,
                secret_name=setup.secret_name,
            )
            await db.set_cluster_active(connection_id)
            rows = [row]
    active = await db.get_cluster_active()
    active_id = active.active_id if active else None
    return [
        ClusterConnectionResponse(
            id=row.id,
            name=row.name,
            mode=row.mode,
            secret_name=row.secret_name,
            is_active=row.id == active_id,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )
        for row in rows
    ]


@router.post("/cluster-connections", response_model=ClusterConnectionResponse)
async def create_cluster_connection(
    request: ClusterConnectionRequest,
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    name = (request.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required.")

    mode = (request.mode or "").strip().lower()
    if mode not in {"in_cluster", "external"}:
        raise HTTPException(status_code=400, detail="Invalid mode. Use in_cluster or external.")

    kubeconfig_text = (request.kubeconfig or "").strip()
    if mode == "external":
        if not kubeconfig_text:
            raise HTTPException(status_code=400, detail="kubeconfig is required for external mode.")
        try:
            data = yaml.safe_load(kubeconfig_text) or {}
            if not data.get("clusters") or not data.get("users"):
                raise ValueError("missing clusters/users")
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid kubeconfig format.")
    else:
        kubeconfig_text = ""

    connection_id = str(uuid.uuid4())
    secret_name = None
    if mode == "external":
        secret_name = f"{settings.SETUP_KUBECONFIG_PREFIX}{connection_id}"
        try:
            upsert_kubeconfig_secret(
                namespace=settings.SETUP_NAMESPACE,
                name=secret_name,
                kubeconfig_text=kubeconfig_text,
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to save kubeconfig: {e}")

    db = await get_db_service()
    row = await db.create_cluster_connection(
        connection_id=connection_id,
        name=name,
        mode=mode,
        secret_name=secret_name,
    )
    return ClusterConnectionResponse(
        id=row.id,
        name=row.name,
        mode=row.mode,
        secret_name=row.secret_name,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.patch("/cluster-connections/{connection_id}/activate")
async def activate_cluster_connection(
    connection_id: str,
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    db = await get_db_service()
    row = await db.get_cluster_connection(connection_id)
    if not row:
        raise HTTPException(status_code=404, detail="Cluster connection not found.")

    try:
        if row.mode == "in_cluster":
            patch_configmap(
                namespace=settings.SETUP_NAMESPACE,
                name=settings.SETUP_CONFIGMAP_NAME,
                data={
                    "IN_CLUSTER": "true",
                    "KUBECONFIG_PATH": "/app/kubeconfig.yaml",
                },
            )
        else:
            if not row.secret_name:
                raise HTTPException(status_code=400, detail="Missing kubeconfig secret.")
            kubeconfig_text = get_kubeconfig_from_secret(
                namespace=settings.SETUP_NAMESPACE,
                name=row.secret_name,
            )
            if not kubeconfig_text:
                raise HTTPException(status_code=400, detail="kubeconfig secret is empty.")

            upsert_kubeconfig_secret(
                namespace=settings.SETUP_NAMESPACE,
                name=settings.SETUP_KUBECONFIG_SECRET,
                kubeconfig_text=kubeconfig_text,
            )
            patch_configmap(
                namespace=settings.SETUP_NAMESPACE,
                name=settings.SETUP_CONFIGMAP_NAME,
                data={
                    "IN_CLUSTER": "false",
                    "KUBECONFIG_PATH": "/app/kubeconfig.yaml",
                },
            )

        restart_deployment(
            namespace=settings.SETUP_NAMESPACE,
            name=settings.SETUP_RESTART_DEPLOYMENT,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to activate cluster: {e}")

    await db.set_cluster_active(connection_id)
    return {"success": True, "active_id": connection_id}


@router.patch("/cluster-connections/{connection_id}", response_model=ClusterConnectionResponse)
async def update_cluster_connection(
    connection_id: str,
    request: ClusterConnectionUpdateRequest,
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    name = (request.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required.")

    db = await get_db_service()
    row = await db.update_cluster_connection_name(connection_id, name)
    if not row:
        raise HTTPException(status_code=404, detail="Cluster connection not found.")

    active = await db.get_cluster_active()
    active_id = active.active_id if active else None
    return ClusterConnectionResponse(
        id=row.id,
        name=row.name,
        mode=row.mode,
        secret_name=row.secret_name,
        is_active=row.id == active_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.delete("/cluster-connections/{connection_id}")
async def delete_cluster_connection(
    connection_id: str,
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    db = await get_db_service()
    active = await db.get_cluster_active()
    if active and active.active_id == connection_id:
        raise HTTPException(status_code=400, detail="Cannot delete the active cluster connection.")
    row = await db.get_cluster_connection(connection_id)
    if not row:
        raise HTTPException(status_code=404, detail="Cluster connection not found.")

    if row.secret_name and row.secret_name.startswith(settings.SETUP_KUBECONFIG_PREFIX):
        try:
            delete_secret(namespace=settings.SETUP_NAMESPACE, name=row.secret_name)
        except Exception:
            pass

    deleted = await db.delete_cluster_connection(connection_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Cluster connection not found.")
    return {"success": True}


@router.get("/me", response_model=UserResponse)
async def me(payload: TokenPayload = Depends(require_auth)):
    db = await get_db_service()
    user = await db.get_user_by_id(payload.user_id)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    return UserResponse(
        id=user.id,
        name=user.name,
        email=user.email,
        hq=getattr(user, "hq", None),
        team=getattr(user, "team", None),
        role=user.role,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )

@router.post("/change-password", response_model=UserResponse)
async def change_password(
    request: ChangePasswordRequest,
    http_request: Request,
    x_request_id: Optional[str] = Header(None, alias="X-Request-ID"),
    payload: TokenPayload = Depends(require_auth),
):
    current_password = request.current_password or ""
    new_password = request.new_password or ""
    if not current_password:
        raise HTTPException(status_code=400, detail="Current password required")
    if not new_password:
        raise HTTPException(status_code=400, detail="New password required")
    if len(new_password) < 4:
        raise HTTPException(status_code=400, detail="New password too short")

    db = await get_db_service()
    user = await db.get_user_by_id(payload.user_id)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    if not verify_password(current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    forwarded_for = http_request.headers.get("X-Forwarded-For")
    request_ip = (forwarded_for.split(",")[0].strip() if forwarded_for else None) or (
        http_request.client.host if http_request.client else None
    )
    user_agent = http_request.headers.get("User-Agent")
    path = str(http_request.url.path)

    updated, audit_row = await db.update_user_password_with_audit(
        actor_user_id=payload.user_id,
        target_user_id=payload.user_id,
        password_hash=hash_password(new_password),
        request_ip=request_ip,
        user_agent=user_agent,
        request_id=x_request_id,
        path=path,
    )

    if not updated:
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        audit_logger.info(
            json.dumps(
                {
                    "action": "user.password.change",
                    "actor_user_id": payload.user_id,
                    "target_user_id": payload.user_id,
                    "request_ip": request_ip,
                    "user_agent": user_agent,
                    "request_id": x_request_id,
                    "path": path,
                    "audit_id": getattr(audit_row, "id", None),
                },
                ensure_ascii=False,
            )
        )
    except Exception:
        pass

    return UserResponse(
        id=updated.id,
        name=updated.name,
        email=updated.email,
        role=updated.role,
        created_at=updated.created_at,
        updated_at=updated.updated_at,
    )


@router.get("/admin/users", response_model=list[UserResponse])
async def admin_list_users(
    limit: int = Query(100, ge=1, le=200),
    offset: int = Query(0, ge=0),
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    db = await get_db_service()
    users = await db.list_users(limit=limit, offset=offset)
    return [
        UserResponse(
            id=u.id,
            name=u.name,
            email=u.email,
            hq=getattr(u, "hq", None),
            team=getattr(u, "team", None),
            role=u.role,
            created_at=u.created_at,
            updated_at=u.updated_at,
        )
        for u in users
    ]


@router.patch("/admin/users/{user_id}", response_model=UserResponse)
async def admin_update_user_role(
    user_id: str,
    request: UpdateUserRoleRequest,
    http_request: Request,
    x_request_id: Optional[str] = Header(None, alias="X-Request-ID"),
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    role = _normalize_role(request.role)
    db = await get_db_service()

    forwarded_for = http_request.headers.get("X-Forwarded-For")
    request_ip = (forwarded_for.split(",")[0].strip() if forwarded_for else None) or (
        http_request.client.host if http_request.client else None
    )
    user_agent = http_request.headers.get("User-Agent")
    path = str(http_request.url.path)

    updated, audit_row = await db.update_user_role_with_audit(
        actor_user_id=payload.user_id,
        target_user_id=user_id,
        role=role,
        request_ip=request_ip,
        user_agent=user_agent,
        request_id=x_request_id,
        path=path,
    )

    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    # App log (structured)
    try:
        audit_logger.info(
            json.dumps(
                {
                    "action": "user.role.update",
                    "actor_user_id": payload.user_id,
                    "target_user_id": user_id,
                    "role": role,
                    "request_ip": request_ip,
                    "user_agent": user_agent,
                    "request_id": x_request_id,
                    "path": path,
                    "audit_id": getattr(audit_row, "id", None),
                },
                ensure_ascii=False,
            )
        )
    except Exception:
        # never block the request on logging failures
        pass

    return UserResponse(
        id=updated.id,
        name=updated.name,
        email=updated.email,
        hq=getattr(updated, "hq", None),
        team=getattr(updated, "team", None),
        role=updated.role,
        created_at=updated.created_at,
        updated_at=updated.updated_at,
    )


@router.post("/admin/users/{user_id}/reset-password", response_model=UserResponse)
async def admin_reset_user_password(
    user_id: str,
    http_request: Request,
    x_request_id: Optional[str] = Header(None, alias="X-Request-ID"),
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    db = await get_db_service()

    forwarded_for = http_request.headers.get("X-Forwarded-For")
    request_ip = (forwarded_for.split(",")[0].strip() if forwarded_for else None) or (
        http_request.client.host if http_request.client else None
    )
    user_agent = http_request.headers.get("User-Agent")
    path = str(http_request.url.path)

    updated, audit_row = await db.reset_user_password_with_audit(
        actor_user_id=payload.user_id,
        target_user_id=user_id,
        password_hash=hash_password("1111"),
        request_ip=request_ip,
        user_agent=user_agent,
        request_id=x_request_id,
        path=path,
    )

    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    try:
        audit_logger.info(
            json.dumps(
                {
                    "action": "user.password.reset",
                    "actor_user_id": payload.user_id,
                    "target_user_id": user_id,
                    "request_ip": request_ip,
                    "user_agent": user_agent,
                    "request_id": x_request_id,
                    "path": path,
                    "audit_id": getattr(audit_row, "id", None),
                },
                ensure_ascii=False,
            )
        )
    except Exception:
        pass

    return UserResponse(
        id=updated.id,
        name=updated.name,
        email=updated.email,
        hq=getattr(updated, "hq", None),
        team=getattr(updated, "team", None),
        role=updated.role,
        created_at=updated.created_at,
        updated_at=updated.updated_at,
    )


@router.delete("/admin/users/{user_id}", status_code=204)
async def admin_delete_user(
    user_id: str,
    http_request: Request,
    x_request_id: Optional[str] = Header(None, alias="X-Request-ID"),
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    if user_id == payload.user_id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")

    db = await get_db_service()

    forwarded_for = http_request.headers.get("X-Forwarded-For")
    request_ip = (forwarded_for.split(",")[0].strip() if forwarded_for else None) or (
        http_request.client.host if http_request.client else None
    )
    user_agent = http_request.headers.get("User-Agent")
    path = str(http_request.url.path)

    deleted, audit_row = await db.delete_user_with_audit(
        actor_user_id=payload.user_id,
        target_user_id=user_id,
        request_ip=request_ip,
        user_agent=user_agent,
        request_id=x_request_id,
        path=path,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="User not found")

    try:
        audit_logger.info(
            json.dumps(
                {
                    "action": "user.delete",
                    "actor_user_id": payload.user_id,
                    "target_user_id": user_id,
                    "request_ip": request_ip,
                    "user_agent": user_agent,
                    "request_id": x_request_id,
                    "path": path,
                    "audit_id": getattr(audit_row, "id", None),
                },
                ensure_ascii=False,
            )
        )
    except Exception:
        pass

    return Response(status_code=204)
