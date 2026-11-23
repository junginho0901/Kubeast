"""Prometheus metrics for ai-service, served at /metrics.

Same names and labels as the Go services (services/pkg/metrics): HTTP request
count / duration / in-flight by route template, plus prometheus_client's
default python/process collectors. The route label is the matched route's
path template ("/api/v1/ai/sessions/{session_id}/chat"), never the raw path,
so cardinality stays bounded. /metrics and the probe paths (SKIP, among them
/api/v1/ai/health, which the chart's kubelet probes ask) are not counted. For a
streamed response (SSE chat) the duration is the time to the response headers.
The endpoint is for an in-cluster scraper on the service port; the gateway
does not proxy it. METRICS_ENABLED=false leaves it unmounted (404).
"""
from __future__ import annotations

import time

import re

from fastapi import FastAPI, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, REGISTRY, Counter, Gauge, Histogram, generate_latest
from prometheus_client.core import GaugeMetricFamily
from starlette.routing import compile_path

SERVICE = "ai"
SKIP = {"/metrics", "/health", "/", "/livez", "/readyz", "/api/v1/ai/health"}

REQUESTS = Counter(
    "kubeast_http_requests_total",
    "HTTP requests handled, by route template and status code.",
    ["service", "method", "route", "code"],
)
DURATION = Histogram(
    "kubeast_http_request_duration_seconds",
    "HTTP request duration in seconds, by route template and status code.",
    ["service", "method", "route", "code"],
)
IN_FLIGHT = Gauge(
    "kubeast_http_requests_in_flight",
    "HTTP requests currently being handled.",
    ["service"],
)


class DBPoolCollector:
    """The database pool's connections, read at each scrape, with the Go services' names (services/pkg/metrics DBPool):
    in use and idle, and the most it may hold. Nothing before the database service is made, nor for sqlite (local runs,
    tests). SQLAlchemy's pool keeps no count of the takes that waited, so those series are the Go services' only."""

    def describe(self):
        # Nothing to check at registration: the series depend on the database service made later.
        return []

    def collect(self):
        from app import database

        svc = database.db_service
        pool = getattr(getattr(svc, "engine", None), "pool", None)
        if svc is None or getattr(svc, "pool_max", None) is None or not hasattr(pool, "checkedout"):
            return
        conns = GaugeMetricFamily(
            "kubeast_db_pool_connections",
            "Database connections of the service's pool, by state (in_use, idle, opening).",
            labels=["service", "state"],
        )
        conns.add_metric([SERVICE, "in_use"], pool.checkedout())
        conns.add_metric([SERVICE, "idle"], pool.checkedin())
        yield conns
        most = GaugeMetricFamily(
            "kubeast_db_pool_max_connections",
            "The most connections the service's pool may hold (postgresql.pool.<service>.maxConns).",
            labels=["service"],
        )
        most.add_metric([SERVICE], svc.pool_max)
        yield most


_POOL_COLLECTOR = DBPoolCollector()
REGISTRY.register(_POOL_COLLECTOR)


_TEMPLATES: dict[int, list[tuple[frozenset[str], "re.Pattern[str]", str]]] = {}


def _templates(app: FastAPI) -> list[tuple[frozenset[str], "re.Pattern[str]", str]]:
    """(methods, path regex, template) for every documented route, in order.

    Built from the OpenAPI document, whose paths carry the include prefixes:
    FastAPI matches prefixed routers lazily, so app.routes does not list their
    templates. Computed once per app.
    """
    table = _TEMPLATES.get(id(app))
    if table is None:
        table = []
        for path, operations in (app.openapi().get("paths") or {}).items():
            regex, _fmt, _conv = compile_path(path)
            table.append((frozenset(m.upper() for m in operations), regex, path))
        _TEMPLATES[id(app)] = table
    return table


def route_template(app: FastAPI, scope: dict) -> str:
    """The path template of the route that handled scope, or "unmatched"."""
    path = scope.get("path", "")
    method = str(scope.get("method", "")).upper()
    for methods, regex, template in _templates(app):
        if method in methods and regex.match(path):
            return template
    return "unmatched"


def install(app: FastAPI, enabled: bool) -> None:
    """Add GET /metrics and the counting middleware when enabled."""
    if not enabled:
        return

    # A plain route rather than a mounted ASGI app: a mount answers the exact
    # path with a redirect to "/metrics/", which a scraper does not follow.
    @app.get("/metrics", include_in_schema=False)
    async def metrics_endpoint() -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    @app.middleware("http")
    async def http_metrics(request: Request, call_next):
        if request.url.path in SKIP:
            return await call_next(request)
        IN_FLIGHT.labels(SERVICE).inc()
        start = time.perf_counter()
        code = "500"
        try:
            response = await call_next(request)
            code = str(response.status_code)
            return response
        finally:
            route = route_template(app, request.scope)
            method = request.method.lower()
            REQUESTS.labels(SERVICE, method, route, code).inc()
            DURATION.labels(SERVICE, method, route, code).observe(time.perf_counter() - start)
            IN_FLIGHT.labels(SERVICE).dec()
