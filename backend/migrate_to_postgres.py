"""
SQLite에서 PostgreSQL로 데이터 마이그레이션
"""
import asyncio
import os
from sqlalchemy import create_engine, select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from app.database import Base, Session, Message, SessionContext

async def migrate_data():
    """SQLite 데이터를 PostgreSQL로 마이그레이션"""
    
    # SQLite 연결 (동기)
    sqlite_url = "sqlite:///./kagent.db"
    sqlite_engine = create_engine(sqlite_url)
    
    # PostgreSQL 연결 (비동기)
    postgres_url = os.getenv("DATABASE_URL", "postgresql+asyncpg://kagent:kagent123@localhost:5432/kagent")
    postgres_engine = create_async_engine(postgres_url, echo=True)
    
    print(f"🔄 Migrating from SQLite to PostgreSQL...")
    print(f"   Source: {sqlite_url}")
    print(f"   Target: {postgres_url}")
    
    # PostgreSQL 테이블 생성
    async with postgres_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    print("✅ PostgreSQL tables created")
    
    # SQLite에서 데이터 읽기
    from sqlalchemy.orm import sessionmaker
    SQLiteSession = sessionmaker(bind=sqlite_engine)
    sqlite_session = SQLiteSession()
    
    try:
        # 세션 데이터 읽기
        sessions = sqlite_session.query(Session).all()
        print(f"📊 Found {len(sessions)} sessions")
        
        # PostgreSQL에 데이터 쓰기
        PostgresSession = async_sessionmaker(postgres_engine, class_=AsyncSession, expire_on_commit=False)
        async with PostgresSession() as pg_session:
            for session in sessions:
                # 세션 복사
                new_session = Session(
                    id=session.id,
                    user_id=session.user_id,
                    title=session.title,
                    created_at=session.created_at,
                    updated_at=session.updated_at
                )
                pg_session.add(new_session)
                print(f"   📝 Migrating session: {session.title}")
                
                # 메시지 복사
                messages = sqlite_session.query(Message).filter(Message.session_id == session.id).all()
                for msg in messages:
                    new_msg = Message(
                        session_id=msg.session_id,
                        role=msg.role,
                        content=msg.content,
                        tool_calls=msg.tool_calls,
                        created_at=msg.created_at
                    )
                    pg_session.add(new_msg)
                print(f"      💬 Migrated {len(messages)} messages")
                
                # 컨텍스트 복사
                context = sqlite_session.query(SessionContext).filter(SessionContext.session_id == session.id).first()
                if context:
                    new_context = SessionContext(
                        session_id=context.session_id,
                        state=context.state,
                        cache=context.cache,
                        updated_at=context.updated_at
                    )
                    pg_session.add(new_context)
                    print(f"      🔧 Migrated context")
            
            await pg_session.commit()
            print("✅ All data migrated successfully!")
            
    finally:
        sqlite_session.close()
    
    await postgres_engine.dispose()

if __name__ == "__main__":
    asyncio.run(migrate_data())
