from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import uuid

from app.database import get_db_service
from app.security import create_access_token, hash_password, jwks, require_auth, TokenPayload, verify_password

router = APIRouter()

ALLOWED_ROLES = {"admin", "user"}


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
    role: str
    created_at: datetime
    updated_at: datetime


class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str


class LoginRequest(BaseModel):
    email: str
    password: str


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse

class UpdateUserRoleRequest(BaseModel):
    role: str


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

    user_id = str(uuid.uuid4())
    user = await db.create_user(
        user_id=user_id,
        name=request.name.strip() or "user",
        email=email,
        password_hash=hash_password(request.password),
        role="user",
    )

    return UserResponse(
        id=user.id,
        name=user.name,
        email=user.email,
        role=user.role,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


@router.post("/login", response_model=AuthResponse)
async def login(request: LoginRequest):
    email = (request.email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Email required")

    db = await get_db_service()
    user = await db.get_user_by_email(email)
    if not user or not verify_password(request.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_access_token(user_id=user.id, role=user.role)
    return AuthResponse(
        access_token=token,
        user=UserResponse(
            id=user.id,
            name=user.name,
            email=user.email,
            role=user.role,
            created_at=user.created_at,
            updated_at=user.updated_at,
        ),
    )


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
        role=user.role,
        created_at=user.created_at,
        updated_at=user.updated_at,
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
    payload: TokenPayload = Depends(require_auth),
):
    _require_admin(payload)
    role = _normalize_role(request.role)
    db = await get_db_service()
    updated = await db.update_user_role(user_id=user_id, role=role)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")
    return UserResponse(
        id=updated.id,
        name=updated.name,
        email=updated.email,
        role=updated.role,
        created_at=updated.created_at,
        updated_at=updated.updated_at,
    )
