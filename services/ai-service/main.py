"""
AI Service - OpenAI 통합 및 AI 기능 전담
Port: 8001
"""
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi import Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.routing import Route
from app.api import router
from app.api_public import admin_router, public_router
from app.api_alert_inbox import router as alert_inbox_router
from app.api_investigations import router as investigations_router
from app.services.investigation import settings as investigation_settings
from app.services.investigation.webhook import router as alerts_router
from app.config import settings
from app.security import require_auth
from app import metrics as console_metrics
from app import mcp_flags
import uvicorn

# The MCP server (MCP_ENABLED): external AI agents reach the clusters through
# Kubeast as the signed-in user. Its session manager runs for the app's lifetime.
# app.mcp_server (and the mcp SDK behind it) is imported only when it is on.
_mcp = None
if mcp_flags.mcp_enabled():
    from app import mcp_server

    _mcp = mcp_server.KubeastMCPServer()


# How long the lifespan's end waits for the investigation worker, after uvicorn's --timeout-graceful-shutdown (Dockerfile),
# inside the 30 s the chart's grace period leaves after its preStop wait.
WORKER_STOP_SECONDS = 4


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Alert investigation (features.alertInvestigation): one worker, only while on.
    stop, worker_task = None, None
    if investigation_settings.load().enabled:
        from app.services.investigation.runner import worker

        stop = asyncio.Event()
        worker_task = asyncio.create_task(worker(stop))
    try:
        if _mcp is None:
            yield
        else:
            async with _mcp.session_manager.run():
                yield
    finally:
        if worker_task is not None:
            stop.set()
            worker_task.cancel()
            # The worker puts a run it held back in the queue (runner.requeue_on_stop) before the process goes.
            try:
                await asyncio.wait_for(worker_task, timeout=WORKER_STOP_SECONDS)
            except (asyncio.CancelledError, Exception):
                pass


app = FastAPI(
    title="AI Service",
    version="1.0.0",
    description="OpenAI 통합 및 AI 분석 서비스",
    lifespan=lifespan,
)

# CORS 설정
allowed_origins = settings.allowed_origins_list
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    # NOTE: allow_origins=["*"] 와 allow_credentials=True 조합은 브라우저에서 동작하지 않습니다.
    # env(ALLOWED_ORIGINS)에 "*"를 넣을 경우 credentials는 자동으로 끕니다.
    allow_credentials="*" not in allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Request body cap (second review M30): uvicorn imposes none. A chat message or
# a model config is a few KB; anything near the limit is not ours.
MAX_REQUEST_BODY_BYTES = int(getattr(settings, "MAX_REQUEST_BODY_BYTES", 0) or 0) or (1 << 20)


@app.middleware("http")
async def limit_request_body(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_REQUEST_BODY_BYTES:
        return JSONResponse(status_code=413, content={"detail": "request body too large"})
    return await call_next(request)


# API 라우터 등록 (인증 필요)
app.include_router(router, prefix="/api/v1/ai", dependencies=[Depends(require_auth)])

# 관리자 전용(모델 연결 테스트) / 공개(health)
app.include_router(admin_router, prefix="/api/v1/ai")
app.include_router(public_router, prefix="/api/v1/ai")

# Alert investigation: Alertmanager's webhook (its own Bearer token, not a user),
# the alert inbox for whoever reads the cluster, and the reports for admin.investigations.read.
app.include_router(alerts_router, prefix="/api/v1/alerts")
app.include_router(alert_inbox_router, prefix="/api/v1/alerts")
app.include_router(investigations_router, prefix="/api/v1/ai/investigations")

if _mcp is not None:
    from app import mcp_server

    # One exact path, so a client never meets a trailing-slash redirect.
    app.router.routes.append(Route(mcp_flags.MCP_PATH, mcp_server.build_mcp_app(_mcp)))

# Console metrics (app/metrics.py): the shared kubeast_http_* instruments at
# /metrics on this port. METRICS_ENABLED=false leaves it unmounted.
_metrics_enabled = getattr(settings, "METRICS_ENABLED", None)
console_metrics.install(app, True if _metrics_enabled is None else bool(_metrics_enabled))


@app.get("/")
async def root():
    """헬스 체크"""
    return {
        "service": "ai-service",
        "version": "1.0.0",
        "status": "healthy"
    }


@app.get("/health")
async def health_check():
    """상세 헬스 체크"""
    return {"status": "healthy"}


# Readiness (the chart's readinessProbe): the database answers. Liveness stays /api/v1/ai/health, which asks nothing.
# From SIGTERM on uvicorn closes its listening socket, so the probe is refused and the pod is not ready.
READY_DB_TIMEOUT = 0.8
_db_warmup = None


def _pool_busy(engine) -> bool:
    """Every pooled connection is taken: a check that ran out of time waited for one, which is load, not a database gone."""
    pool = engine.pool
    try:
        return pool.checkedin() == 0 and pool.checkedout() >= pool.size()
    except Exception:
        return False


async def _database_answers() -> None:
    global _db_warmup
    from sqlalchemy import text
    from app import database

    if not database.db_initialized:
        # The first use initializes the database (schema wait, default model); a probe's 0.8 s must not cut it short.
        if _db_warmup is None or _db_warmup.done():
            _db_warmup = asyncio.create_task(database.get_db_service())
            _db_warmup.add_done_callback(lambda t: t.cancelled() or t.exception())
        raise RuntimeError("database not initialized yet")
    async with database.db_service.engine.connect() as conn:
        await conn.execute(text("SELECT 1"))


@app.get("/readyz")
async def readiness():
    from app import database

    try:
        await asyncio.wait_for(_database_answers(), timeout=READY_DB_TIMEOUT)
    except asyncio.TimeoutError:
        if database.db_service is None or not _pool_busy(database.db_service.engine):
            return JSONResponse(status_code=503, content={"status": "not ready", "waiting_for": ["database"]})
    except Exception:
        return JSONResponse(status_code=503, content={"status": "not ready", "waiting_for": ["database"]})
    return {"status": "ready"}


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8001,
        reload=settings.DEBUG
    )
