"""
Session management endpoints
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime
import uuid

from app.database import get_db_service

router = APIRouter()


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


@router.get("/sessions")
async def list_sessions(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """세션 목록 조회"""
    try:
        db = await get_db_service()
        rows = await db.list_sessions_with_message_counts(limit=limit, offset=offset)
        
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
async def create_session(request: CreateSessionRequest):
    """새 세션 생성"""
    try:
        db = await get_db_service()
        session_id = str(uuid.uuid4())
        session = await db.create_session(
            session_id=session_id,
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
async def get_session(session_id: str):
    """세션 상세 조회"""
    try:
        db = await get_db_service()
        session = await db.get_session(session_id)
        
        if not session:
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
async def update_session(session_id: str, request: UpdateSessionRequest):
    """세션 제목 업데이트"""
    try:
        db = await get_db_service()
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
async def save_messages(session_id: str, request: SaveMessagesRequest):
    """세션에 메시지 저장 (중단된 메시지 저장용)"""
    try:
        db = await get_db_service()
        
        # 세션 존재 확인
        session = await db.get_session(session_id)
        if not session:
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
async def delete_session(session_id: str):
    """세션 삭제"""
    try:
        db = await get_db_service()
        await db.delete_session(session_id)
        return {"message": "Session deleted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
