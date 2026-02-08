"""
Database models and user management
"""
from datetime import datetime
from typing import Optional, List, Dict, Any, Tuple

from sqlalchemy import Column, String, DateTime, Integer, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

Base = declarative_base()


class User(Base):
    __tablename__ = "auth_users"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    email = Column(String, nullable=False, unique=True)
    role = Column(String, nullable=False, default="user")  # admin | user
    password_hash = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

class AuditLog(Base):
    __tablename__ = "auth_audit_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    action = Column(String, nullable=False)  # e.g. "user.role.update"

    actor_user_id = Column(String, nullable=True)
    actor_email = Column(String, nullable=True)

    target_user_id = Column(String, nullable=True)
    target_email = Column(String, nullable=True)

    before = Column(JSON, nullable=True, default=dict)
    after = Column(JSON, nullable=True, default=dict)

    request_ip = Column(String, nullable=True)
    user_agent = Column(String, nullable=True)
    request_id = Column(String, nullable=True)
    path = Column(String, nullable=True)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class DatabaseService:
    def __init__(self, database_url: str = None):
        import os

        if database_url is None:
            database_url = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./kagent.db")

        self.database_url = database_url
        self.engine = create_async_engine(database_url, echo=False)
        self.async_session = async_sessionmaker(self.engine, class_=AsyncSession, expire_on_commit=False)

    async def init_db(self):
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def get_user_by_id(self, user_id: str) -> Optional[User]:
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(select(User).where(User.id == user_id))
            return result.scalar_one_or_none()

    async def get_user_by_email(self, email: str) -> Optional[User]:
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(select(User).where(User.email == email))
            return result.scalar_one_or_none()

    async def create_user(self, user_id: str, name: str, email: str, password_hash: str, role: str = "user") -> User:
        async with self.async_session() as db:
            user = User(id=user_id, name=name, email=email, password_hash=password_hash, role=role)
            db.add(user)
            await db.commit()
            await db.refresh(user)
            return user

    async def list_users(self, limit: int = 100, offset: int = 0) -> List[User]:
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(
                select(User)
                .order_by(User.created_at.desc(), User.id.desc())
                .limit(limit)
                .offset(offset)
            )
            return list(result.scalars().all())

    async def update_user_role(self, user_id: str, role: str) -> Optional[User]:
        async with self.async_session() as db:
            from sqlalchemy import select, update

            await db.execute(
                update(User)
                .where(User.id == user_id)
                .values(role=role, updated_at=datetime.utcnow())
            )
            await db.commit()

            result = await db.execute(select(User).where(User.id == user_id))
            return result.scalar_one_or_none()

    async def add_audit_log(
        self,
        *,
        action: str,
        actor_user_id: Optional[str],
        actor_email: Optional[str],
        target_user_id: Optional[str],
        target_email: Optional[str],
        before: Optional[Dict[str, Any]] = None,
        after: Optional[Dict[str, Any]] = None,
        request_ip: Optional[str] = None,
        user_agent: Optional[str] = None,
        request_id: Optional[str] = None,
        path: Optional[str] = None,
    ) -> AuditLog:
        async with self.async_session() as db:
            row = AuditLog(
                action=action,
                actor_user_id=actor_user_id,
                actor_email=actor_email,
                target_user_id=target_user_id,
                target_email=target_email,
                before=before or {},
                after=after or {},
                request_ip=request_ip,
                user_agent=user_agent,
                request_id=request_id,
                path=path,
            )
            db.add(row)
            await db.commit()
            await db.refresh(row)
            return row

    async def update_user_role_with_audit(
        self,
        *,
        actor_user_id: str,
        target_user_id: str,
        role: str,
        request_ip: Optional[str] = None,
        user_agent: Optional[str] = None,
        request_id: Optional[str] = None,
        path: Optional[str] = None,
    ) -> Tuple[Optional[User], Optional[AuditLog]]:
        async with self.async_session() as db:
            from sqlalchemy import select

            actor = (await db.execute(select(User).where(User.id == actor_user_id))).scalar_one_or_none()
            target = (await db.execute(select(User).where(User.id == target_user_id))).scalar_one_or_none()
            if not target:
                return None, None

            before = {"role": target.role}
            target.role = role
            target.updated_at = datetime.utcnow()

            audit = AuditLog(
                action="user.role.update",
                actor_user_id=actor_user_id,
                actor_email=getattr(actor, "email", None),
                target_user_id=target_user_id,
                target_email=getattr(target, "email", None),
                before=before,
                after={"role": role},
                request_ip=request_ip,
                user_agent=user_agent,
                request_id=request_id,
                path=path,
            )
            db.add(audit)
            await db.commit()
            await db.refresh(target)
            await db.refresh(audit)
            return target, audit

    async def reset_user_password_with_audit(
        self,
        *,
        actor_user_id: str,
        target_user_id: str,
        password_hash: str,
        request_ip: Optional[str] = None,
        user_agent: Optional[str] = None,
        request_id: Optional[str] = None,
        path: Optional[str] = None,
    ) -> Tuple[Optional[User], Optional[AuditLog]]:
        async with self.async_session() as db:
            from sqlalchemy import select

            actor = (await db.execute(select(User).where(User.id == actor_user_id))).scalar_one_or_none()
            target = (await db.execute(select(User).where(User.id == target_user_id))).scalar_one_or_none()
            if not target:
                return None, None

            target.password_hash = password_hash
            target.updated_at = datetime.utcnow()

            audit = AuditLog(
                action="user.password.reset",
                actor_user_id=actor_user_id,
                actor_email=getattr(actor, "email", None),
                target_user_id=target_user_id,
                target_email=getattr(target, "email", None),
                before={},
                after={"password_reset": True},
                request_ip=request_ip,
                user_agent=user_agent,
                request_id=request_id,
                path=path,
            )
            db.add(audit)
            await db.commit()
            await db.refresh(target)
            await db.refresh(audit)
            return target, audit

    async def ensure_bootstrap_admin(self):
        from app.config import settings
        from app.security import hash_password

        email = settings.DEFAULT_ADMIN_EMAIL.strip().lower()
        if not email:
            return

        existing = await self.get_user_by_email(email)
        if existing:
            return

        await self.create_user(
            user_id="default",
            name="admin",
            email=email,
            password_hash=hash_password(settings.DEFAULT_ADMIN_PASSWORD),
            role="admin",
        )


db_service: Optional[DatabaseService] = None


async def get_db_service() -> DatabaseService:
    global db_service
    if db_service is None:
        db_service = DatabaseService()
        await db_service.init_db()
        await db_service.ensure_bootstrap_admin()
    return db_service
