"""
Database models and session management
"""
from datetime import datetime
from typing import Optional, List, Dict, Any
from sqlalchemy import func
from sqlalchemy import Column, String, DateTime, Text, JSON, Integer, ForeignKey, create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship, sessionmaker
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
import json

Base = declarative_base()


class Session(Base):
    """대화 세션"""
    __tablename__ = "sessions"
    
    id = Column(String, primary_key=True)
    user_id = Column(String, nullable=False, default="default")
    title = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationships
    messages = relationship("Message", back_populates="session", cascade="all, delete-orphan")
    context = relationship("SessionContext", back_populates="session", uselist=False, cascade="all, delete-orphan")


class Message(Base):
    """대화 메시지"""
    __tablename__ = "messages"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("sessions.id"), nullable=False)
    role = Column(String, nullable=False)  # user, assistant, tool
    content = Column(Text, nullable=False)
    tool_calls = Column(JSON, nullable=True)  # Function calling 정보
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    
    # Relationships
    session = relationship("Session", back_populates="messages")


class SessionContext(Base):
    """세션 컨텍스트 (Tool 실행 상태 저장)"""
    __tablename__ = "session_contexts"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("sessions.id"), nullable=False, unique=True)
    state = Column(JSON, nullable=False, default=dict)  # Tool 실행 상태
    cache = Column(JSON, nullable=False, default=dict)  # 조회 결과 캐시
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationships
    session = relationship("Session", back_populates="context")


class DatabaseService:
    """데이터베이스 서비스"""
    
    def __init__(self, database_url: str = None):
        import os
        if database_url is None:
            database_url = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./kagent.db")
        
        self.database_url = database_url
        self.engine = create_async_engine(database_url, echo=False)
        self.async_session = async_sessionmaker(
            self.engine,
            class_=AsyncSession,
            expire_on_commit=False
        )
    
    async def init_db(self):
        """데이터베이스 초기화"""
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    
    async def create_session(self, session_id: str, user_id: str = "default", title: str = "New Chat") -> Session:
        """새 세션 생성"""
        async with self.async_session() as db:
            session = Session(
                id=session_id,
                user_id=user_id,
                title=title
            )
            # 초기 컨텍스트 생성
            context = SessionContext(
                session_id=session_id,
                state={},
                cache={}
            )
            db.add(session)
            db.add(context)
            await db.commit()
            await db.refresh(session)
            return session
    
    async def get_session(self, session_id: str) -> Optional[Session]:
        """세션 조회"""
        async with self.async_session() as db:
            from sqlalchemy import select
            result = await db.execute(
                select(Session).where(Session.id == session_id)
            )
            return result.scalar_one_or_none()
    
    async def list_sessions(self, user_id: str = "default", limit: int = 50) -> List[Session]:
        """세션 목록 조회"""
        async with self.async_session() as db:
            from sqlalchemy import select
            result = await db.execute(
                select(Session)
                .where(Session.user_id == user_id)
                .order_by(Session.updated_at.desc())
                .limit(limit)
            )
            return list(result.scalars().all())
    
    async def update_session_title(self, session_id: str, title: str):
        """세션 제목 업데이트"""
        async with self.async_session() as db:
            from sqlalchemy import select, update
            await db.execute(
                update(Session)
                .where(Session.id == session_id)
                .values(title=title, updated_at=datetime.utcnow())
            )
            await db.commit()
    
    async def delete_session(self, session_id: str):
        """세션 삭제"""
        async with self.async_session() as db:
            from sqlalchemy import select
            result = await db.execute(
                select(Session).where(Session.id == session_id)
            )
            session = result.scalar_one_or_none()
            if session:
                await db.delete(session)
                await db.commit()
    
    async def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        tool_calls: Optional[List[Dict]] = None
    ) -> Message:
        """메시지 추가"""
        async with self.async_session() as db:
            message = Message(
                session_id=session_id,
                role=role,
                content=content,
                tool_calls=tool_calls
            )
            db.add(message)
            
            # 세션 updated_at 갱신
            from sqlalchemy import update
            await db.execute(
                update(Session)
                .where(Session.id == session_id)
                .values(updated_at=datetime.utcnow())
            )
            
            await db.commit()
            await db.refresh(message)
            return message
    
    async def get_messages(self, session_id: str, limit: int = 100) -> List[Message]:
        """메시지 목록 조회"""
        async with self.async_session() as db:
            from sqlalchemy import select
            result = await db.execute(
                select(Message)
                .where(Message.session_id == session_id)
                # 최신 메시지부터 limit 만큼 가져온 뒤(내림차순), UI/모델에서 자연스럽게 읽히도록 다시 오름차순으로 반환한다.
                .order_by(Message.created_at.desc(), Message.id.desc())
                .limit(limit)
            )
            messages = list(result.scalars().all())
            messages.reverse()
            return messages

    async def get_message_count(self, session_id: str) -> int:
        """세션의 전체 메시지 개수 조회"""
        async with self.async_session() as db:
            from sqlalchemy import select
            result = await db.execute(
                select(func.count(Message.id)).where(Message.session_id == session_id)
            )
            return int(result.scalar_one())
    
    async def get_context(self, session_id: str) -> Optional[SessionContext]:
        """세션 컨텍스트 조회"""
        async with self.async_session() as db:
            from sqlalchemy import select
            result = await db.execute(
                select(SessionContext).where(SessionContext.session_id == session_id)
            )
            return result.scalar_one_or_none()
    
    async def update_context(self, session_id: str, state: Dict = None, cache: Dict = None):
        """세션 컨텍스트 업데이트"""
        async with self.async_session() as db:
            from sqlalchemy import select, update
            
            updates = {"updated_at": datetime.utcnow()}
            if state is not None:
                updates["state"] = state
            if cache is not None:
                updates["cache"] = cache
            
            await db.execute(
                update(SessionContext)
                .where(SessionContext.session_id == session_id)
                .values(**updates)
            )
            await db.commit()


# 전역 데이터베이스 서비스 인스턴스
db_service: Optional[DatabaseService] = None


async def get_db_service() -> DatabaseService:
    """데이터베이스 서비스 가져오기"""
    global db_service
    if db_service is None:
        db_service = DatabaseService()
        await db_service.init_db()
    return db_service
