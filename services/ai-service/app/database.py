"""
Database models and session management
"""
from datetime import UTC, datetime
from typing import Optional, List, Dict, Any
from sqlalchemy import func
from sqlalchemy import Column, String, DateTime, Text, JSON, Integer, ForeignKey, Boolean, UniqueConstraint
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
import asyncio
import logging

logger = logging.getLogger(__name__)

Base = declarative_base()


def utcnow() -> datetime:
    """현재 UTC 시각(naive) — DateTime 컬럼이 timezone 없이 저장된다."""
    return datetime.now(UTC).replace(tzinfo=None)


class Session(Base):
    """대화 세션"""
    __tablename__ = "sessions"
    
    id = Column(String, primary_key=True)
    user_id = Column(String, nullable=False, default="default")
    cluster_id = Column(String, nullable=True)  # step 13: per-cluster scope
    title = Column(String, nullable=False)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)
    
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
    # The answered turn's token usage (00018): prompt/completion/cached tokens, model calls, model
    usage = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    
    # Relationships
    session = relationship("Session", back_populates="messages")


class SessionContext(Base):
    """세션 컨텍스트 (Tool 실행 상태 저장)"""
    __tablename__ = "session_contexts"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("sessions.id"), nullable=False, unique=True)
    state = Column(JSON, nullable=False, default=dict)  # Tool 실행 상태
    cache = Column(JSON, nullable=False, default=dict)  # 조회 결과 캐시
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)
    
    # Relationships
    session = relationship("Session", back_populates="context")


class ToolApproval(Base):
    """AI 쓰기 툴 승인 요청 (H2). 모델이 고른 쓰기 툴은 여기 pending 으로 남고,
    사용자가 승인해야 저장된 인자 그대로 실행된다."""
    __tablename__ = "tool_approvals"

    id = Column(String, primary_key=True)
    session_id = Column(String, ForeignKey("sessions.id"), nullable=False)
    user_id = Column(String, nullable=False)
    user_email = Column(String, nullable=True)
    cluster = Column(String, nullable=False)
    tool = Column(String, nullable=False)
    args = Column(JSON, nullable=False, default=dict)
    status = Column(String, nullable=False, default="pending")  # pending|approved|executed|failed|rejected|expired
    result = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    expires_at = Column(DateTime, nullable=False)
    decided_at = Column(DateTime, nullable=True)


# An approved call's run is over this long after its approval, whichever ai-service runs it: tool-server takes the call
# while its token lasts (120 s, approval_token.sign) and answers within 60 s (tool_server_client); the rest is room for
# the database writes after the run and for the clocks of two servers.
APPROVED_RUN_LIMIT_SECONDS = 600
INTERRUPTED_RESULT = (
    "interrupted: ai-service stopped before this run's outcome was written, so whether it changed the cluster is not "
    "known; check the cluster before asking again"
)


class ModelConfig(Base):
    """모델 설정 (DB 기반)"""
    __tablename__ = "model_configs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False, unique=True)
    provider = Column(String, nullable=False, default="openai")
    model = Column(String, nullable=False)
    base_url = Column(String, nullable=True)

    # API key is never stored; this names the ai-service env var holding it
    api_key_env = Column(String, nullable=True)

    # Legacy K8s Secret ref (kept for backward compat)
    api_key_secret_name = Column(String, nullable=True)
    api_key_secret_key = Column(String, nullable=True)

    extra_headers = Column(JSON, nullable=False, default=dict)
    tls_verify = Column(Boolean, nullable=False, default=True)
    # 자체 서명 HTTPS 로컬 엔드포인트용 CA 인증서(PEM). 비어 있으면 시스템 CA 사용.
    ca_cert = Column(String, nullable=True)
    # 생성 옵션(temperature, top_p, seed, num_ctx ...) — 매 요청에 주입.
    # 로컬/셀프호스트(Ollama 등) 모델 튜닝용. kagent 의 ollama.options 와 동일 목적.
    options = Column(JSON, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    is_default = Column(Boolean, nullable=False, default=False)
    # "default" or "economy" — the cheaper model history summaries and the floating assistant use (00017)
    tier = Column(String, nullable=False, default="default", server_default="default")

    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)


class AlertInvestigation(Base):
    """Alert → AI investigation (services/pkg/dbmigrate 00014_alert_investigations.sql)."""
    __tablename__ = "alert_investigations"

    id = Column(String, primary_key=True)
    cluster = Column(String, nullable=False)
    fingerprint = Column(String, nullable=False)
    alertname = Column(String, nullable=False, default="")
    severity = Column(String, nullable=False, default="")
    namespace = Column(String, nullable=False, default="")
    status = Column(String, nullable=False)
    skip_reason = Column(String, nullable=False, default="")
    labels = Column(JSON, nullable=False, default=dict)
    annotations = Column(JSON, nullable=False, default=dict)
    starts_at = Column(DateTime, nullable=True)
    generator_url = Column(Text, nullable=False, default="")
    alertmanager_url = Column(Text, nullable=False, default="")
    group_key = Column(Text, nullable=False, default="")
    received_at = Column(DateTime, nullable=False, default=utcnow)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    repeat_count = Column(Integer, nullable=False, default=1)
    last_seen_at = Column(DateTime, nullable=False, default=utcnow)
    provider = Column(String, nullable=False, default="")
    model = Column(String, nullable=False, default="")
    prompt_tokens = Column(Integer, nullable=True)
    completion_tokens = Column(Integer, nullable=True)
    total_tokens = Column(Integer, nullable=True)
    iterations = Column(Integer, nullable=False, default=0)
    tool_calls = Column(JSON, nullable=False, default=list)
    report = Column(Text, nullable=False, default="")
    error = Column(Text, nullable=False, default="")
    # the email of the person who asked for it in the Alerts inbox, "" when the webhook queued it (00021)
    requested_by = Column(String, nullable=False, default="")
    # times a stopping ai-service put it back in the queue; a second stop ends it failed (00029)
    stop_requeues = Column(Integer, nullable=False, default=0, server_default="0")
    # what the server read of the report's rca block and the hypothesis ledger, null with both
    # features.alertInvestigation.evidenceCheck and ledger off (00031, investigation/result.py)
    result = Column(JSON, nullable=True)


class AlertInboxItem(Base):
    """One alert Alertmanager sent, firing or resolved, with Kubeast's handling marks (00020_alert_inbox.sql)."""
    __tablename__ = "alert_inbox"
    __table_args__ = (UniqueConstraint("cluster", "fingerprint", "starts_at", name="alert_inbox_alert"),)

    id = Column(String, primary_key=True)
    cluster = Column(String, nullable=False)
    fingerprint = Column(String, nullable=False)
    starts_at = Column(DateTime, nullable=False)
    alertname = Column(String, nullable=False, default="")
    severity = Column(String, nullable=False, default="")
    namespace = Column(String, nullable=False, default="")
    labels = Column(JSON, nullable=False, default=dict)
    annotations = Column(JSON, nullable=False, default=dict)
    state = Column(String, nullable=False)
    resolved_at = Column(DateTime, nullable=True)
    first_received_at = Column(DateTime, nullable=False, default=utcnow)
    last_received_at = Column(DateTime, nullable=False, default=utcnow)
    received_count = Column(Integer, nullable=False, default=1)
    generator_url = Column(Text, nullable=False, default="")
    alertmanager_url = Column(Text, nullable=False, default="")
    receiver = Column(String, nullable=False, default="")
    group_key = Column(Text, nullable=False, default="")
    acked_by = Column(String, nullable=False, default="")
    acked_at = Column(DateTime, nullable=True)
    assignee = Column(String, nullable=False, default="")
    note = Column(Text, nullable=False, default="")
    note_by = Column(String, nullable=False, default="")
    note_at = Column(DateTime, nullable=True)
    done_by = Column(String, nullable=False, default="")
    done_at = Column(DateTime, nullable=True)


class ClaudeCodeSlot(Base):
    """One install-wide Claude Code slot (00027_claude_code_slots.sql): owner '' is free (app/services/claude_code_slots.py)."""
    __tablename__ = "claude_code_slots"

    lane = Column(String, primary_key=True)
    slot = Column(Integer, primary_key=True)
    owner = Column(String, nullable=False, default="", server_default="")
    heartbeat_at = Column(DateTime(timezone=True), nullable=True)


# Schema version this build needs — the newest file in
# services/pkg/dbmigrate/migrations (goose records it in goose_db_version).
REQUIRED_SCHEMA_VERSION = 31


async def read_schema_version(engine) -> int:
    """Applied goose version, 0 when the version table does not exist yet."""
    from sqlalchemy import text

    async with engine.connect() as conn:
        exists = (await conn.execute(text(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'goose_db_version')"
        ))).scalar()
        if not exists:
            return 0
        row = (await conn.execute(text(
            "SELECT version_id FROM goose_db_version WHERE is_applied ORDER BY id DESC LIMIT 1"
        ))).scalar()
        return int(row or 0)


async def wait_for_schema(engine, required: int, timeout_seconds: float = 60.0, poll_seconds: float = 2.0) -> int:
    """Block until the database is at least at `required`; raise after the timeout."""
    import asyncio
    import time

    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            version = await read_schema_version(engine)
            error = None
        except Exception as exc:  # DB may still be starting
            version, error = 0, exc
        if error is None and version >= required:
            return version
        if time.monotonic() >= deadline:
            if error is not None:
                raise RuntimeError(f"schema version check failed: {error}") from error
            raise RuntimeError(
                f"schema version {required} required, database is at {version} — run the auth-service migrations first"
            )
        print(f"[DB] waiting for schema version {required} (current {version}, err={error})", flush=True)
        await asyncio.sleep(poll_seconds)


class DatabaseService:
    """데이터베이스 서비스"""
    
    def __init__(self, database_url: str = None):
        import os
        if database_url is None:
            database_url = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./kubeast.db")
        
        self.database_url = database_url
        # sslmode / sslrootcert are libpq parameters (shared URL with the Go
        # services); asyncpg needs them as an `ssl` connect argument instead.
        engine_url, connect_args, pool = database_url, {}, {}
        session_statements: list[str] = []
        if "postgresql" in database_url:
            from app.db_session import pool_args, statements
            from app.db_ssl import split_ssl_params

            engine_url, connect_args = split_ssl_params(database_url)
            pool = pool_args()
            session_statements = statements()
        # pool_pre_ping: a pooled connection that died with a Postgres restart
        # is replaced on checkout instead of surfacing as "connection is
        # closed" on the first request after the database is back.
        self.engine = create_async_engine(engine_url, echo=False, pool_pre_ping=True, connect_args=connect_args, **pool)
        # The session limits (app/db_session.py), SET on each new connection.
        self.on_connect = None
        if session_statements:
            from sqlalchemy import event

            from app.db_session import on_connect

            self.on_connect = on_connect(session_statements)
            event.listen(self.engine.sync_engine, "connect", self.on_connect)
        self.async_session = async_sessionmaker(
            self.engine,
            class_=AsyncSession,
            expire_on_commit=False
        )
    
    async def init_db(self):
        """Make sure the schema this build needs is present.

        Postgres: the schema is owned by auth-service (services/pkg/dbmigrate,
        goose); no DDL runs here — wait for the required version and fail with
        a clear message if it does not arrive. sqlite (local dev, tests): the
        ORM models create the tables.
        """
        if "postgresql" not in str(self.database_url):
            async with self.engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            return
        await wait_for_schema(self.engine, REQUIRED_SCHEMA_VERSION)
    
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
            from sqlalchemy import update
            await db.execute(
                update(Session)
                .where(Session.id == session_id)
                .values(title=title, updated_at=utcnow())
            )
            await db.commit()
    
    async def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        tool_calls: Optional[List[Dict]] = None,
        usage: Optional[Dict] = None,
    ) -> Message:
        """메시지 추가"""
        async with self.async_session() as db:
            message = Message(
                session_id=session_id,
                role=role,
                content=content,
                tool_calls=tool_calls,
                usage=usage,
            )
            db.add(message)
            
            # 세션 updated_at 갱신
            from sqlalchemy import update
            await db.execute(
                update(Session)
                .where(Session.id == session_id)
                .values(updated_at=utcnow())
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
                # 최신 메시지부터 limit 만큼 가져온 뒤(내림차순), 이후 로직에서 자연스럽게 읽히도록 다시 오름차순으로 반환한다.
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
            from sqlalchemy import update
            
            updates = {"updated_at": utcnow()}
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

    # ===== Model Configs =====
    async def list_model_configs(self, enabled_only: bool = False) -> List[ModelConfig]:
        async with self.async_session() as db:
            from sqlalchemy import select
            query = select(ModelConfig)
            if enabled_only:
                query = query.where(ModelConfig.enabled.is_(True))
            query = query.order_by(ModelConfig.is_default.desc(), ModelConfig.updated_at.desc())
            result = await db.execute(query)
            return list(result.scalars().all())

    async def get_model_config(self, config_id: int) -> Optional[ModelConfig]:
        async with self.async_session() as db:
            from sqlalchemy import select
            result = await db.execute(
                select(ModelConfig).where(ModelConfig.id == config_id)
            )
            return result.scalar_one_or_none()

    async def get_active_model_config(self) -> Optional[ModelConfig]:
        """The chat's model: the default one, else a default-tier one, else the newest enabled."""
        async with self.async_session() as db:
            from sqlalchemy import select
            result = await db.execute(
                select(ModelConfig)
                .where(ModelConfig.enabled.is_(True))
                .order_by(ModelConfig.is_default.desc(), (ModelConfig.tier == "economy").asc(),
                          ModelConfig.updated_at.desc())
                .limit(1)
            )
            return result.scalar_one_or_none()

    async def get_economy_model_config(self) -> Optional[ModelConfig]:
        """The newest enabled economy-tier config (history summaries, the floating assistant), or None."""
        async with self.async_session() as db:
            from sqlalchemy import select
            result = await db.execute(
                select(ModelConfig)
                .where(ModelConfig.enabled.is_(True), ModelConfig.tier == "economy")
                .order_by(ModelConfig.updated_at.desc())
                .limit(1)
            )
            return result.scalar_one_or_none()

    # ---- tool approvals (H2) ----

    async def create_tool_approval(
        self,
        *,
        session_id: str,
        user_id: str,
        user_email: Optional[str],
        cluster: str,
        tool: str,
        args: Dict[str, Any],
        ttl_seconds: int = 600,
    ) -> ToolApproval:
        import uuid
        from datetime import timedelta

        await self._expire_waiting_tool_approvals()
        await self.close_interrupted_tool_approvals()
        async with self.async_session() as db:
            row = ToolApproval(
                id=uuid.uuid4().hex,
                session_id=session_id,
                user_id=user_id,
                user_email=user_email,
                cluster=cluster,
                tool=tool,
                args=args or {},
                status="pending",
                expires_at=utcnow() + timedelta(seconds=ttl_seconds),
            )
            db.add(row)
            await db.commit()
            await db.refresh(row)
            return row

    async def _expire_waiting_tool_approvals(self, limit: int = 50) -> None:
        """Calls nobody decided in time can no longer run, so their arguments stay only masked. A card opened later does
        this too; here those no one opens again get there. A failure here must not stop the new call."""
        from sqlalchemy import select

        from app.services.audit_target import kept_tool_args

        try:
            async with self.async_session() as db:
                now = utcnow()
                rows = await db.execute(
                    select(ToolApproval).where(ToolApproval.status == "pending", ToolApproval.expires_at < now).limit(limit)
                )
                for row in rows.scalars().all():
                    row.status, row.decided_at, row.args = "expired", now, kept_tool_args(row.args)
                await db.commit()
        except Exception as e:
            logger.warning("tool approvals: could not expire waiting calls: %s", e.__class__.__name__)

    async def close_interrupted_tool_approvals(self, approval_id: Optional[str] = None, limit: int = 50) -> int:
        """Approved calls whose run never wrote its outcome, because the ai-service running it stopped (out of memory, a
        lost node, the shutdown cutting the request), end failed with a masked copy of their arguments and an
        ai.tool.interrupt row. Only past APPROVED_RUN_LIMIT_SECONDS, so no server ends a run another is still on.
        The row moves and its audit row is written in one transaction: the UPDATE holds the row, so of two servers one
        ends it and writes the row, and with AUDIT_FAIL_CLOSED an audit row that cannot be stored leaves the approval
        approved for a later sweep (with it off the row is ended and the audit row written after, as elsewhere).
        approval_id: that one only. A new card and an opened card do this, and the first database use of the process.
        A failure here must not stop them. Returns how many it ended."""
        from datetime import timedelta

        from sqlalchemy import select, update

        from app.services import audit_writer
        from app.services.audit_target import ToolTarget, kept_tool_args, tool_target

        strict = audit_writer.fail_closed_enabled()
        ended = 0
        try:
            if strict and not (await audit_writer.audit_ready())[0]:
                return 0  # no row could be written now
            query = select(ToolApproval).where(
                ToolApproval.status == "approved",
                ToolApproval.decided_at < utcnow() - timedelta(seconds=APPROVED_RUN_LIMIT_SECONDS),
            )
            if approval_id is not None:
                query = query.where(ToolApproval.id == approval_id)
            async with self.async_session() as db:
                rows = (await db.execute(query.order_by(ToolApproval.decided_at).limit(limit))).scalars().all()
            for row in rows:
                args = dict(row.args or {})
                try:
                    target = tool_target(row.tool, args)
                except Exception:
                    target = ToolTarget("tool", row.tool, None, None)
                record = dict(
                    action="ai.tool.interrupt", actor_user_id="system", actor_email="system", cluster=row.cluster,
                    target_type=target.type, target_id=target.id, namespace=target.namespace,
                    after={"approval_id": row.id, "session_id": row.session_id, "cluster": row.cluster, "tool": row.tool,
                           "approved_by": row.user_id, "approved_by_email": row.user_email,
                           "approved_at": row.decided_at.isoformat() + "Z", "end_reason": "interrupted"},
                )
                async with self.engine.connect() as conn:
                    await conn.begin()
                    moved = await conn.execute(
                        update(ToolApproval)
                        .where(ToolApproval.id == row.id, ToolApproval.status == "approved")
                        .values(status="failed", result=INTERRUPTED_RESULT, decided_at=utcnow(), args=kept_tool_args(args))
                    )
                    if moved.rowcount != 1:
                        await conn.rollback()
                        continue  # its run ended meanwhile, or another server ended it
                    if strict and not await audit_writer.write_audit(**record, conn=conn):
                        await conn.rollback()
                        continue  # stays approved until a sweep can write the row
                    await conn.commit()
                if not strict:
                    await audit_writer.write_audit(**record)
                ended += 1
        except Exception as e:
            logger.warning("tool approvals: could not end interrupted runs: %s", e.__class__.__name__)
        return ended

    async def get_tool_approval(self, approval_id: str) -> Optional[ToolApproval]:
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(select(ToolApproval).where(ToolApproval.id == approval_id))
            return result.scalar_one_or_none()

    async def list_tool_approvals(self, session_id: str, user_id: str, pending_only: bool = True) -> List[ToolApproval]:
        async with self.async_session() as db:
            from sqlalchemy import select

            stmt = select(ToolApproval).where(
                ToolApproval.session_id == session_id, ToolApproval.user_id == user_id
            )
            if pending_only:
                stmt = stmt.where(ToolApproval.status == "pending")
            result = await db.execute(stmt.order_by(ToolApproval.created_at))
            return list(result.scalars().all())

    async def update_tool_approval(self, approval_id: str, **fields: Any) -> Optional[ToolApproval]:
        async with self.async_session() as db:
            from sqlalchemy import select

            result = await db.execute(select(ToolApproval).where(ToolApproval.id == approval_id))
            row = result.scalar_one_or_none()
            if row is None:
                return None
            for key, value in fields.items():
                setattr(row, key, value)
            await db.commit()
            await db.refresh(row)
            return row

    async def transition_tool_approval(self, approval_id: str, from_status: str, **fields: Any) -> Optional[ToolApproval]:
        """Move an approval out of `from_status` in one statement. Two callers
        racing on the same approval cannot both win: the UPDATE matches only
        while the row still has `from_status`, and the caller whose rowcount
        is 0 gets None."""
        async with self.async_session() as db:
            from sqlalchemy import select, update

            result = await db.execute(
                update(ToolApproval)
                .where(ToolApproval.id == approval_id, ToolApproval.status == from_status)
                .values(**fields)
            )
            if result.rowcount != 1:
                await db.rollback()
                return None
            await db.commit()
            return (await db.execute(select(ToolApproval).where(ToolApproval.id == approval_id))).scalar_one_or_none()

    async def create_model_config(self, data: Dict[str, Any]) -> ModelConfig:
        async with self.async_session() as db:
            from sqlalchemy import select, update
            # 중복 이름 방지
            exists = await db.execute(
                select(ModelConfig).where(ModelConfig.name == data.get("name"))
            )
            if exists.scalar_one_or_none():
                raise ValueError("Model config name already exists")

            config = ModelConfig(**data)
            db.add(config)
            # flush to assign auto-increment id before referencing it
            await db.flush()

            if config.is_default:
                await db.execute(
                    update(ModelConfig)
                    .where(ModelConfig.id != config.id)
                    .values(is_default=False)
                )

            await db.commit()
            await db.refresh(config)
            return config

    async def update_model_config(self, config_id: int, data: Dict[str, Any]) -> Optional[ModelConfig]:
        async with self.async_session() as db:
            from sqlalchemy import select, update
            result = await db.execute(
                select(ModelConfig).where(ModelConfig.id == config_id)
            )
            config = result.scalar_one_or_none()
            if not config:
                return None
            # the name is unique: another config's name is refused as on create, not left to the database's constraint
            if data.get("name") and data["name"] != config.name:
                taken = await db.execute(
                    select(ModelConfig).where(ModelConfig.name == data["name"], ModelConfig.id != config_id)
                )
                if taken.scalar_one_or_none():
                    raise ValueError("Model config name already exists")

            for key, value in data.items():
                setattr(config, key, value)

            if data.get("is_default") is True:
                await db.execute(
                    update(ModelConfig)
                    .where(ModelConfig.id != config.id)
                    .values(is_default=False)
                )

            await db.commit()
            await db.refresh(config)
            return config

    async def delete_model_config(self, config_id: int) -> bool:
        async with self.async_session() as db:
            from sqlalchemy import select
            result = await db.execute(
                select(ModelConfig).where(ModelConfig.id == config_id)
            )
            config = result.scalar_one_or_none()
            if not config:
                return False
            await db.delete(config)
            await db.commit()
            return True

    async def ensure_default_model_config(self):
        """Backward compat: create a default config only if none exist AND
        a direct OPENAI_API_KEY env var is available."""
        async with self.async_session() as db:
            from sqlalchemy import select
            import os
            result = await db.execute(select(func.count(ModelConfig.id)))
            count = int(result.scalar_one() or 0)
            if count > 0:
                return

            # Only create a default if an actual API key is in env
            api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
            if not api_key or api_key == "change-me":
                print("[DB] Skipping default model config (no valid OPENAI_API_KEY)", flush=True)
                return

            from app.config import settings
            base_url = (settings.OPENAI_BASE_URL or "").strip() or None

            config = ModelConfig(
                name="default-openai",
                provider="openai",
                model=settings.OPENAI_MODEL,
                base_url=base_url,
                api_key_env="OPENAI_API_KEY",
                extra_headers={},
                tls_verify=True,
                enabled=True,
                is_default=True,
            )
            db.add(config)
            await db.commit()
            print(f"[DB] Created default model config: {config.model}", flush=True)


# 전역 데이터베이스 서비스 인스턴스
db_service: Optional[DatabaseService] = None
db_initialized: bool = False
# Approved runs a stopped ai-service left, from before this version too, are ended once at the first database use.
interrupted_checked: bool = False
# Requests that arrive together on a cold service share one initialisation (two
# sqlite create_all calls collide on "table already exists"). One lock per event
# loop: a Lock that has waited on one loop cannot be awaited on another.
_init_lock: Optional[asyncio.Lock] = None
_init_lock_loop: Optional[asyncio.AbstractEventLoop] = None


def _db_init_lock() -> asyncio.Lock:
    global _init_lock, _init_lock_loop
    loop = asyncio.get_running_loop()
    if _init_lock is None or _init_lock_loop is not loop:
        _init_lock, _init_lock_loop = asyncio.Lock(), loop
    return _init_lock


async def get_db_service() -> DatabaseService:
    """데이터베이스 서비스 가져오기"""
    global db_service, db_initialized, interrupted_checked
    if db_service is None:
        db_service = DatabaseService()
        db_initialized = False
    if not db_initialized:
        async with _db_init_lock():
            if not db_initialized:
                await db_service.init_db()
                await db_service.ensure_default_model_config()
                db_initialized = True
    if not interrupted_checked:
        interrupted_checked = True  # before the call: its audit rows come back here
        await db_service.close_interrupted_tool_approvals()
    return db_service
