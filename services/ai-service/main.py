"""
AI Service - OpenAI 통합 및 AI 기능 전담
Port: 8001
"""
import asyncio
import signal
import threading
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


def stop_on_shutdown_signal(stop: asyncio.Event):
    """Sets stop the moment SIGTERM or SIGINT comes and hands the signal on to the handler already there, uvicorn's
    Server.handle_exit (uvicorn installs it before it imports the app). uvicorn ends the lifespan only after it has waited
    for the answers in flight (--timeout-graceful-shutdown, Dockerfile), and the worker would take new investigations
    all that time. Returns what puts the handlers back. Signals go to the main thread only: off it (a test client) and
    for a signal with no Python handler it changes nothing."""
    if threading.current_thread() is not threading.main_thread():
        return lambda: None
    loop = asyncio.get_running_loop()
    previous = {}

    def handle(sig, frame):
        loop.call_soon_threadsafe(stop.set)
        previous[sig](sig, frame)

    for sig in (signal.SIGTERM, signal.SIGINT):
        handler = signal.getsignal(sig)
        if callable(handler):
            previous[sig] = handler
            signal.signal(sig, handle)

    def restore():
        for sig, handler in previous.items():
            if signal.getsignal(sig) is handle:
                signal.signal(sig, handler)

    return restore


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Alert investigation (features.alertInvestigation): one worker, only while on. From the stop signal on it takes no
    # new run; one still running when the lifespan ends is cut and put back in the queue.
    stop, worker_task, restore_signals = None, None, None
    if investigation_settings.load().enabled:
        from app.services.investigation.runner import worker

        stop = asyncio.Event()
        restore_signals = stop_on_shutdown_signal(stop)
        worker_task = asyncio.create_task(worker(stop))
    try:
        if _mcp is None:
            yield
        else:
            async with _mcp.session_manager.run():
                yield
    finally:
        if worker_task is not None:
            restore_signals()
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


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8001,
        reload=settings.DEBUG
    )
