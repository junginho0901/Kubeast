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


class Member(Base):
    """멤버 (추후 권한/RBAC의 주체)"""
    __tablename__ = "members"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    role = Column(String, nullable=False, default="user")  # admin | user
    # 로그인용 계정 정보 (초기 마이그레이션/기존 데이터 호환을 위해 nullable 허용)
    email = Column(String, nullable=True, unique=False)
    password_hash = Column(String, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


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

    async def migrate_members_auth_columns(self):
        """members 테이블에 auth 컬럼/인덱스 추가 (create_all은 기존 테이블 변경을 하지 않음)"""
        from sqlalchemy import text
        backend = self.engine.url.get_backend_name()

        async with self.engine.begin() as conn:
            if backend.startswith("postgres"):
                await conn.execute(
                    text("ALTER TABLE members ADD COLUMN IF NOT EXISTS email VARCHAR")
                )
                await conn.execute(
                    text("ALTER TABLE members ADD COLUMN IF NOT EXISTS password_hash VARCHAR")
                )
                # email 은 NULL 허용이므로 partial unique index로 중복 방지
                await conn.execute(
                    text("CREATE UNIQUE INDEX IF NOT EXISTS ix_members_email_unique ON members (email) WHERE email IS NOT NULL")
                )
                return

            # sqlite fallback
            if backend.startswith("sqlite"):
                result = await conn.execute(text("PRAGMA table_info(members)"))
                cols = {row[1] for row in result.fetchall()}  # type: ignore[index]
                if "email" not in cols:
                    await conn.execute(text("ALTER TABLE members ADD COLUMN email VARCHAR"))
                if "password_hash" not in cols:
                    await conn.execute(text("ALTER TABLE members ADD COLUMN password_hash VARCHAR"))
                try:
                    await conn.execute(
                        text("CREATE UNIQUE INDEX IF NOT EXISTS ix_members_email_unique ON members (email) WHERE email IS NOT NULL")
                    )
                except Exception:
                    # older sqlite may not support partial indexes
                    pass

    async def ensure_bootstrap_admin(self) -> Member:
        """기본 admin 계정 보장 (초기 로그인 진입용)"""
        import os
        from sqlalchemy import select

        admin_email = os.getenv("DEFAULT_ADMIN_EMAIL", "admin@local")
        admin_password = os.getenv("DEFAULT_ADMIN_PASSWORD", "admin")

        from app.security import hash_password

        async with self.async_session() as db:
            # 1) 기존 default 멤버가 있으면 업그레이드
            result = await db.execute(select(Member).where(Member.id == "default"))
            existing = result.scalar_one_or_none()
            if existing:
                changed = False
                if not existing.email:
                    existing.email = admin_email
                    changed = True
                if not existing.password_hash:
                    existing.password_hash = hash_password(admin_password)
                    changed = True
                if existing.role != "admin":
                    existing.role = "admin"
                    changed = True
                if existing.name != "admin":
                    existing.name = "admin"
                    changed = True
                if changed:
                    await db.commit()
                    await db.refresh(existing)
                return existing

            # 2) email 기반 admin이 있으면 사용
            result = await db.execute(select(Member).where(Member.email == admin_email))
            existing_by_email = result.scalar_one_or_none()
            if existing_by_email:
                return existing_by_email

            # 3) 없으면 생성
            member = Member(
                id="default",
                name="admin",
                role="admin",
                email=admin_email,
                password_hash=hash_password(admin_password),
            )
            db.add(member)
            await db.commit()
            await db.refresh(member)
            return member

    async def create_member(self, member_id: str, name: str, role: str = "user") -> Member:
        """멤버 생성"""
        async with self.async_session() as db:
            member = Member(id=member_id, name=name, role=role)
            db.add(member)
            await db.commit()
            await db.refresh(member)
            return member

    async def create_member_with_credentials(self, member_id: str, name: str, email: str, password_hash: str, role: str = "user") -> Member:
        """멤버 생성(계정/비번 포함)"""
        async with self.async_session() as db:
            member = Member(id=member_id, name=name, role=role, email=email, password_hash=password_hash)
            db.add(member)
            await db.commit()
            await db.refresh(member)
            return member

    async def get_member(self, member_id: str) -> Optional[Member]:
        """멤버 조회"""
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(select(Member).where(Member.id == member_id))
            return result.scalar_one_or_none()

    async def get_member_by_email(self, email: str) -> Optional[Member]:
        """이메일로 멤버 조회"""
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(select(Member).where(Member.email == email))
            return result.scalar_one_or_none()

    async def list_members(self, limit: int = 100, offset: int = 0) -> List[Member]:
        """멤버 목록 조회"""
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(
                select(Member)
                .order_by(Member.created_at.asc(), Member.id.asc())
                .limit(limit)
                .offset(offset)
            )
            return list(result.scalars().all())

    async def update_member(
        self,
        member_id: str,
        name: Optional[str] = None,
        role: Optional[str] = None,
        email: Optional[str] = None,
        password_hash: Optional[str] = None,
    ) -> Optional[Member]:
        """멤버 업데이트"""
        async with self.async_session() as db:
            from sqlalchemy import select, update

            updates = {"updated_at": datetime.utcnow()}
            if name is not None:
                updates["name"] = name
            if role is not None:
                updates["role"] = role
            if email is not None:
                updates["email"] = email
            if password_hash is not None:
                updates["password_hash"] = password_hash

            await db.execute(update(Member).where(Member.id == member_id).values(**updates))
            await db.commit()

            result = await db.execute(select(Member).where(Member.id == member_id))
            return result.scalar_one_or_none()

    async def delete_member(self, member_id: str) -> bool:
        """멤버 삭제"""
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(select(Member).where(Member.id == member_id))
            member = result.scalar_one_or_none()
            if not member:
                return False

            await db.delete(member)
            await db.commit()
            return True
    
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
    
    async def list_sessions(self, user_id: str = "default", limit: int = 50, offset: int = 0) -> List[Session]:
        """세션 목록 조회 (최근 업데이트 순)"""
        async with self.async_session() as db:
            from sqlalchemy import select
            result = await db.execute(
                select(Session)
                .where(Session.user_id == user_id)
                .order_by(Session.updated_at.desc(), Session.id.desc())
                .limit(limit)
                .offset(offset)
            )
            return list(result.scalars().all())

    async def list_sessions_with_message_counts(
        self,
        user_id: str = "default",
        limit: int = 50,
        offset: int = 0,
        before_updated_at: Optional[datetime] = None,
        before_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """세션 목록 + 메시지 개수 조회 (N+1 방지)"""
        async with self.async_session() as db:
            from sqlalchemy import select, and_, or_

            stmt = (
                select(
                    Session,
                    func.count(Message.id).label("message_count"),
                )
                .outerjoin(Message, Message.session_id == Session.id)
                .where(Session.user_id == user_id)
                .group_by(Session.id)
                .order_by(Session.updated_at.desc(), Session.id.desc())
                .limit(limit)
            )

            # 커서 기반 페이지네이션: (updated_at, id) 가 (cursor_updated_at, cursor_id) 보다 "작은" 것만
            # (정렬이 desc이므로 "작다" = 더 과거)
            if before_updated_at is not None:
                if before_id:
                    stmt = stmt.where(
                        or_(
                            Session.updated_at < before_updated_at,
                            and_(Session.updated_at == before_updated_at, Session.id < before_id),
                        )
                    )
                else:
                    stmt = stmt.where(Session.updated_at < before_updated_at)
            else:
                # 기존 offset 기반도 유지 (호환)
                stmt = stmt.offset(offset)

            result = await db.execute(stmt)

            rows = result.all()
            return [
                {
                    "session": session,
                    "message_count": int(message_count or 0),
                }
                for session, message_count in rows
            ]
    
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
        await db_service.migrate_members_auth_columns()
        await db_service.ensure_bootstrap_admin()
    return db_service
