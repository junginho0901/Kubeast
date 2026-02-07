"""
Session management endpoints
"""
from fastapi import APIRouter, HTTPException, Query, Header, Depends
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
import uuid

from app.database import get_db_service

router = APIRouter()

ALLOWED_ROLES = {"admin", "user"}


def _normalize_role(role: str) -> str:
    value = (role or "").strip().lower()
    if value not in ALLOWED_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role: {role}. Allowed: {sorted(ALLOWED_ROLES)}")
    return value


async def get_current_member_id(
    x_member_id: Optional[str] = Header(None, alias="X-Member-ID"),
    x_user_id: Optional[str] = Header(None, alias="X-User-ID"),
) -> str:
    member_id = (x_member_id or x_user_id or "default").strip()
    return member_id or "default"


class MemberResponse(BaseModel):
    id: str
    name: str
    role: str
    created_at: datetime
    updated_at: datetime


class CreateMemberRequest(BaseModel):
    name: str
    role: str = "user"


class UpdateMemberRequest(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None


class SessionResponse(BaseModel):
    id: str
    title: str
    created_at: datetime
    updated_at: datetime
    message_count: int = 0


class CreateSessionRequest(BaseModel):
    title: Optional[str] = "New Chat"


class UpdateSessionRequest(BaseModel):
    title: str


class MessageRequest(BaseModel):
    role: str
    content: str
    tool_calls: Optional[list] = None


class SaveMessagesRequest(BaseModel):
    messages: List[MessageRequest]


@router.get("/members", response_model=List[MemberResponse])
async def list_members(
    limit: int = Query(100, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """멤버 목록 조회"""
    try:
        db = await get_db_service()
        members = await db.list_members(limit=limit, offset=offset)
        return [
            MemberResponse(
                id=m.id,
                name=m.name,
                role=m.role,
                created_at=m.created_at,
                updated_at=m.updated_at,
            )
            for m in members
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/members", response_model=MemberResponse)
async def create_member(request: CreateMemberRequest):
    """멤버 생성"""
    try:
        db = await get_db_service()
        role = _normalize_role(request.role)
        member_id = str(uuid.uuid4())
        member = await db.create_member(member_id=member_id, name=request.name, role=role)
        return MemberResponse(
            id=member.id,
            name=member.name,
            role=member.role,
            created_at=member.created_at,
            updated_at=member.updated_at,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/members/me", response_model=MemberResponse)
async def get_me(member_id: str = Depends(get_current_member_id)):
    """현재 멤버 조회 (헤더 기반)"""
    try:
        db = await get_db_service()
        member = await db.get_member(member_id)
        if not member:
            raise HTTPException(status_code=404, detail="Member not found")
        return MemberResponse(
            id=member.id,
            name=member.name,
            role=member.role,
            created_at=member.created_at,
            updated_at=member.updated_at,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/members/{member_id}", response_model=MemberResponse)
async def update_member(member_id: str, request: UpdateMemberRequest):
    """멤버 업데이트"""
    try:
        db = await get_db_service()
        role = _normalize_role(request.role) if request.role is not None else None
        updated = await db.update_member(member_id=member_id, name=request.name, role=role)
        if not updated:
            raise HTTPException(status_code=404, detail="Member not found")
        return MemberResponse(
            id=updated.id,
            name=updated.name,
            role=updated.role,
            created_at=updated.created_at,
            updated_at=updated.updated_at,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/members/{member_id}")
async def delete_member(member_id: str):
    """멤버 삭제"""
    if member_id == "default":
        raise HTTPException(status_code=400, detail="Cannot delete default member")
    try:
        db = await get_db_service()
        ok = await db.delete_member(member_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Member not found")
        return {"message": "Member deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sessions")
async def list_sessions(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    before_updated_at: Optional[datetime] = Query(None),
    before_id: Optional[str] = Query(None),
    member_id: str = Depends(get_current_member_id),
):
    """세션 목록 조회"""
    try:
        db = await get_db_service()
        rows = await db.list_sessions_with_message_counts(
            user_id=member_id,
            limit=limit,
            offset=offset,
            before_updated_at=before_updated_at,
            before_id=before_id,
        )
        
        result = [
            SessionResponse(
                id=row["session"].id,
                title=row["session"].title,
                created_at=row["session"].created_at,
                updated_at=row["session"].updated_at,
                message_count=row["message_count"],
            )
            for row in rows
        ]
        
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sessions")
async def create_session(request: CreateSessionRequest, member_id: str = Depends(get_current_member_id)):
    """새 세션 생성"""
    try:
        db = await get_db_service()
        member = await db.get_member(member_id)
        if not member:
            raise HTTPException(status_code=404, detail="Member not found")
        session_id = str(uuid.uuid4())
        session = await db.create_session(
            session_id=session_id,
            user_id=member_id,
            title=request.title or "New Chat"
        )
        
        return SessionResponse(
            id=session.id,
            title=session.title,
            created_at=session.created_at,
            updated_at=session.updated_at,
            message_count=0
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, member_id: str = Depends(get_current_member_id)):
    """세션 상세 조회"""
    try:
        db = await get_db_service()
        session = await db.get_session(session_id)
        
        if not session or session.user_id != member_id:
            raise HTTPException(status_code=404, detail="Session not found")
        
        messages = await db.get_messages(session_id)
        
        return {
            "id": session.id,
            "title": session.title,
            "created_at": session.created_at,
            "updated_at": session.updated_at,
            "messages": [
                {
                    "id": msg.id,
                    "role": msg.role,
                    "content": msg.content,
                    "tool_calls": msg.tool_calls,
                    "created_at": msg.created_at
                }
                for msg in messages
            ]
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/sessions/{session_id}")
async def update_session(session_id: str, request: UpdateSessionRequest, member_id: str = Depends(get_current_member_id)):
    """세션 제목 업데이트"""
    try:
        db = await get_db_service()
        existing = await db.get_session(session_id)
        if not existing or existing.user_id != member_id:
            raise HTTPException(status_code=404, detail="Session not found")
        await db.update_session_title(session_id, request.title)
        
        session = await db.get_session(session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        
        message_count = await db.get_message_count(session_id)
        
        return SessionResponse(
            id=session.id,
            title=session.title,
            created_at=session.created_at,
            updated_at=session.updated_at,
            message_count=message_count
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sessions/{session_id}/messages")
async def save_messages(session_id: str, request: SaveMessagesRequest, member_id: str = Depends(get_current_member_id)):
    """세션에 메시지 저장 (중단된 메시지 저장용)"""
    try:
        db = await get_db_service()
        
        # 세션 존재 확인
        session = await db.get_session(session_id)
        if not session or session.user_id != member_id:
            raise HTTPException(status_code=404, detail="Session not found")
        
        # 메시지 저장
        for msg in request.messages:
            await db.add_message(session_id, msg.role, msg.content, tool_calls=msg.tool_calls)
        
        return {"success": True, "message": "Messages saved successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str, member_id: str = Depends(get_current_member_id)):
    """세션 삭제"""
    try:
        db = await get_db_service()
        session = await db.get_session(session_id)
        if not session or session.user_id != member_id:
            raise HTTPException(status_code=404, detail="Session not found")
        await db.delete_session(session_id)
        return {"message": "Session deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
