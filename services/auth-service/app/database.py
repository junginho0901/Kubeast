"""
Database models and user management
"""
from datetime import datetime
import uuid
from typing import Optional, List, Dict, Any, Tuple

from sqlalchemy import Column, String, DateTime, Integer, JSON, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

Base = declarative_base()


class User(Base):
    __tablename__ = "auth_users"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    email = Column(String, nullable=False, unique=True)
    hq = Column(String, nullable=True)  # 본부
    team = Column(String, nullable=True)  # 팀
    role = Column(String, nullable=False, default="read")  # admin | read | write
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


class ClusterSetup(Base):
    __tablename__ = "cluster_setup"

    id = Column(Integer, primary_key=True, autoincrement=True)
    mode = Column(String, nullable=False)  # in_cluster | external
    secret_name = Column(String, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class ClusterConnection(Base):
    __tablename__ = "cluster_connections"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    mode = Column(String, nullable=False)  # in_cluster | external
    secret_name = Column(String, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class ClusterActive(Base):
    __tablename__ = "cluster_active"

    id = Column(Integer, primary_key=True, autoincrement=True)
    active_id = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


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
            await self._migrate_user_org_fields(conn)
            await self._backfill_default_org_fields(conn)

    async def _migrate_user_org_fields(self, conn):
        """
        Dev-friendly migration for adding new nullable columns.
        (Avoids a full Alembic setup for now.)
        """
        # Prefer Postgres syntax when possible.
        try:
            await conn.execute(text("ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS hq VARCHAR"))
            await conn.execute(text("ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS team VARCHAR"))
            return
        except Exception:
            pass

        # Fallback for SQLite (no IF NOT EXISTS on older versions)
        for col in ("hq", "team"):
            try:
                await conn.execute(text(f"ALTER TABLE auth_users ADD COLUMN {col} VARCHAR"))
            except Exception:
                # Ignore if column already exists
                pass

    async def _backfill_default_org_fields(self, conn):
        """
        Backfill existing users with default org fields (only when missing).
        This is intentionally idempotent and won't override non-empty values.
        """
        default_hq = "오케스트로"
        default_team = "AI팀"
        try:
            await conn.execute(text("UPDATE auth_users SET hq = :hq WHERE hq IS NULL OR hq = ''"), {"hq": default_hq})
            await conn.execute(text("UPDATE auth_users SET team = :team WHERE team IS NULL OR team = ''"), {"team": default_team})
        except Exception:
            # best-effort only; never block service startup
            pass

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

    async def create_user(
        self,
        user_id: str,
        name: str,
        email: str,
        password_hash: str,
        role: str = "read",
        hq: Optional[str] = None,
        team: Optional[str] = None,
    ) -> User:
        async with self.async_session() as db:
            user = User(id=user_id, name=name, email=email, password_hash=password_hash, role=role, hq=hq, team=team)
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

    async def update_user_password_with_audit(
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
                action="user.password.change",
                actor_user_id=actor_user_id,
                actor_email=getattr(actor, "email", None),
                target_user_id=target_user_id,
                target_email=getattr(target, "email", None),
                before={},
                after={"password_changed": True},
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

    async def delete_user_with_audit(
        self,
        *,
        actor_user_id: str,
        target_user_id: str,
        request_ip: Optional[str] = None,
        user_agent: Optional[str] = None,
        request_id: Optional[str] = None,
        path: Optional[str] = None,
    ) -> Tuple[bool, Optional[AuditLog]]:
        async with self.async_session() as db:
            from sqlalchemy import select

            actor = (await db.execute(select(User).where(User.id == actor_user_id))).scalar_one_or_none()
            target = (await db.execute(select(User).where(User.id == target_user_id))).scalar_one_or_none()
            if not target:
                return False, None

            audit = AuditLog(
                action="user.delete",
                actor_user_id=actor_user_id,
                actor_email=getattr(actor, "email", None),
                target_user_id=target_user_id,
                target_email=getattr(target, "email", None),
                before={"role": target.role, "email": target.email, "name": target.name},
                after={"deleted": True},
                request_ip=request_ip,
                user_agent=user_agent,
                request_id=request_id,
                path=path,
            )
            db.add(audit)
            await db.delete(target)
            await db.commit()
            await db.refresh(audit)
            return True, audit

    async def get_cluster_setup(self) -> Optional[ClusterSetup]:
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(select(ClusterSetup).order_by(ClusterSetup.id.asc()).limit(1))
            return result.scalar_one_or_none()

    async def set_cluster_setup(self, mode: str, secret_name: Optional[str]) -> ClusterSetup:
        async with self.async_session() as db:
            from sqlalchemy import select

            existing = (await db.execute(select(ClusterSetup).order_by(ClusterSetup.id.asc()).limit(1))).scalar_one_or_none()
            if existing:
                existing.mode = mode
                existing.secret_name = secret_name
                existing.updated_at = datetime.utcnow()
                await db.commit()
                await db.refresh(existing)
                return existing

            row = ClusterSetup(mode=mode, secret_name=secret_name)
            db.add(row)
            await db.commit()
            await db.refresh(row)
            return row

    async def list_cluster_connections(self) -> List[ClusterConnection]:
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(select(ClusterConnection).order_by(ClusterConnection.created_at.asc()))
            return list(result.scalars().all())

    async def get_cluster_connection(self, connection_id: str) -> Optional[ClusterConnection]:
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(select(ClusterConnection).where(ClusterConnection.id == connection_id))
            return result.scalar_one_or_none()

    async def create_cluster_connection(
        self,
        *,
        connection_id: str,
        name: str,
        mode: str,
        secret_name: Optional[str],
    ) -> ClusterConnection:
        async with self.async_session() as db:
            row = ClusterConnection(
                id=connection_id,
                name=name,
                mode=mode,
                secret_name=secret_name,
            )
            db.add(row)
            await db.commit()
            await db.refresh(row)
            return row

    async def delete_cluster_connection(self, connection_id: str) -> bool:
        async with self.async_session() as db:
            from sqlalchemy import select

            row = (await db.execute(select(ClusterConnection).where(ClusterConnection.id == connection_id))).scalar_one_or_none()
            if not row:
                return False
            await db.delete(row)
            await db.commit()
            return True

    async def update_cluster_connection_name(self, connection_id: str, name: str) -> Optional[ClusterConnection]:
        async with self.async_session() as db:
            from sqlalchemy import select

            row = (await db.execute(select(ClusterConnection).where(ClusterConnection.id == connection_id))).scalar_one_or_none()
            if not row:
                return None
            row.name = name
            row.updated_at = datetime.utcnow()
            await db.commit()
            await db.refresh(row)
            return row

    async def get_cluster_active(self) -> Optional[ClusterActive]:
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(select(ClusterActive).order_by(ClusterActive.id.asc()).limit(1))
            return result.scalar_one_or_none()

    async def set_cluster_active(self, connection_id: str) -> ClusterActive:
        async with self.async_session() as db:
            from sqlalchemy import select

            existing = (await db.execute(select(ClusterActive).order_by(ClusterActive.id.asc()).limit(1))).scalar_one_or_none()
            if existing:
                existing.active_id = connection_id
                existing.updated_at = datetime.utcnow()
                await db.commit()
                await db.refresh(existing)
                return existing

            row = ClusterActive(active_id=connection_id)
            db.add(row)
            await db.commit()
            await db.refresh(row)
            return row

    async def ensure_bootstrap_admin(self):
        from app.config import settings
        from app.security import hash_password

        async def ensure_user(email: str, password: str, role: str, name: str):
            if not email:
                return
            existing = await self.get_user_by_email(email)
            if existing:
                return
            await self.create_user(
                user_id=str(uuid.uuid4()),
                name=name,
                email=email,
                password_hash=hash_password(password),
                role=role,
            )

        admin_email = settings.DEFAULT_ADMIN_EMAIL.strip().lower()
        await ensure_user(admin_email, settings.DEFAULT_ADMIN_PASSWORD, "admin", "admin")

        read_email = settings.DEFAULT_READ_EMAIL.strip().lower()
        await ensure_user(read_email, settings.DEFAULT_READ_PASSWORD, "read", "read")

        write_email = settings.DEFAULT_WRITE_EMAIL.strip().lower()
        await ensure_user(write_email, settings.DEFAULT_WRITE_PASSWORD, "write", "write")


db_service: Optional[DatabaseService] = None


async def get_db_service() -> DatabaseService:
    global db_service
    if db_service is None:
        db_service = DatabaseService()
        await db_service.init_db()
        await db_service.ensure_bootstrap_admin()
    return db_service
