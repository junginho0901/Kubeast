"""
Database models and user management
"""
from datetime import datetime
from typing import Optional, List

from sqlalchemy import Column, String, DateTime
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
