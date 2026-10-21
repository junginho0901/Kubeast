"""The worker and one investigation.

The worker runs only while features.alertInvestigation is on. It claims the
oldest queued row, asks auth-service for the investigator's token for that
cluster (and the alert's namespace), and runs the read-only tools through the
same path the chat uses — tool-server checks the token's ai.tool.* rights and
namespace, the cluster sees kubeast:investigator. At most max_steps model calls;
the last one gets no tools, so it must answer (as HolmesGPT does) — the loop is
app.services.ai.tool_turn, which hands it to Claude Code on a Claude subscription.
The whole run is bounded by timeout_seconds.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import timedelta
from typing import Any, Optional

import httpx

from app.database import get_db_service, utcnow
from app.services.ai.debug_dump import safe_error
from app.services.ai.model_errors import classify
from app.services.audit_writer import audit_ready, write_audit
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import settings as inv_settings
from app.services.investigation import store
from app.services.investigation import webhook

log = logging.getLogger(__name__)

ACTOR_ID = "system"
ACTOR_EMAIL = "kubeast:investigator"
# A provider error can echo the key it was given (OpenAI: "Incorrect API key provided: sk-proj-…"), which the shared
# redaction does not know: any long opaque run is masked before the error is stored or audited.
_OPAQUE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_\-]{23,}")


def clean_error(err: Exception) -> str:
    return _OPAQUE.sub("[redacted]", safe_error(err))[:300]
POLL_SECONDS = 15
SUMMARY_CHARS = 500


class InvestigationError(Exception):
    pass


async def fetch_token(cfg: inv_settings.InvestigationSettings, cluster: str, namespace: str) -> str:
    if not cfg.internal_token:
        raise InvestigationError("INTERNAL_API_TOKEN is not set")
    body = {"cluster_id": cluster}
    if namespace:
        body["namespace"] = namespace
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(cfg.token_url, json=body, headers={"X-Internal-Token": cfg.internal_token})
    if resp.status_code != 200:
        raise InvestigationError(f"investigator token refused by auth-service ({resp.status_code})")
    token = (resp.json() or {}).get("access_token") or ""
    if not token:
        raise InvestigationError("auth-service answered without a token")
    return token


async def build_service(cfg: inv_settings.InvestigationSettings, token: str, cluster: str):
    from app.services.ai_service import AIService
    from app.services.model_config_service import resolve_model_config

    config_id: Optional[int] = None
    if cfg.model:
        db = await get_db_service()
        config_id = await store.model_config_id(db, cfg.model)
        if config_id is None:
            raise InvestigationError(f'model config "{cfg.model}" (features.alertInvestigation.model) not found')
    resolved = await resolve_model_config(config_id=config_id) if config_id is not None else await resolve_model_config()
    service = AIService(
        provider=resolved.provider,
        model=resolved.model,
        base_url=resolved.base_url,
        api_key=resolved.api_key,
        extra_headers=resolved.extra_headers,
        tls_verify=resolved.tls_verify,
        ca_cert=resolved.ca_cert,
        options=resolved.options,
    )
    service.update_authorization(f"Bearer {token}", cluster_name=cluster)
    return service


def alert_view(row) -> dict[str, Any]:
    return {
        "alertname": row.alertname,
        "severity": row.severity,
        "namespace": row.namespace,
        "labels": row.labels or {},
        "annotations": row.annotations or {},
        "startsAt": row.starts_at.isoformat() + "Z" if row.starts_at else None,
        "generatorURL": row.generator_url,
    }


def link_for(cfg: inv_settings.InvestigationSettings, inv_id: str) -> Optional[str]:
    return f"{cfg.console_url}/admin/investigations?id={inv_id}" if cfg.console_url else None


async def investigate(cfg: inv_settings.InvestigationSettings, row) -> dict[str, Any]:
    """Run one investigation; return the fields to store. Raises on failure."""
    from app.services.ai import formatters
    from app.services.ai import permissions as perm
    from app.services.ai.tool_turn import run_tool_turn
    from app.services.ai_service import ToolContext
    from app.services.tool_whitelists import READONLY_TOOL_NAMES, readonly_tool_filter

    deadline = time.monotonic() + cfg.timeout_seconds
    # The investigator reads the cluster (logs included) as the system; it does so only when the reads are recorded.
    if not (await audit_ready())[0]:
        raise InvestigationError("audit log unavailable: not investigated")

    def remaining() -> float:
        left = deadline - time.monotonic()
        if left <= 0:
            raise InvestigationError(f"timed out after {cfg.timeout_seconds}s")
        return left

    token = await asyncio.wait_for(fetch_token(cfg, row.cluster, row.namespace), timeout=remaining())
    service = await build_service(cfg, token, row.cluster)
    from app.services.ai import features as feature_gate
    tools = await feature_gate.gate_tools(readonly_tool_filter(service._get_tools_definition()), service)
    context = ToolContext(session_id=f"investigation:{row.id}")
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": inv_prompt.system_prompt(cluster=row.cluster, namespace=row.namespace, language=cfg.language)},
        {"role": "user", "content": inv_prompt.alert_message(cluster=row.cluster, alert=alert_view(row))},
    ]
    tool_log: list[dict[str, Any]] = []

    async def run_tool(name: str, args: dict, step: int) -> str:
        entry: dict[str, Any] = {"tool": name, "args": args, "step": step}
        if name not in READONLY_TOOL_NAMES:
            result = json.dumps({"error": f"'{name}' is not a read-only tool; investigations only read"})
            entry["error"] = "not a read-only tool"
        elif not (await audit_ready())[0]:
            result = json.dumps({"status": "audit_unavailable"})
            entry["error"] = "audit unavailable"
        else:
            try:
                raw = await asyncio.wait_for(service._execute_function_with_context(name, args, context), timeout=remaining())
                formatted, _is_json, _is_yaml = formatters._format_tool_result(name, args, raw)
                result = formatters._truncate_tool_result_for_llm(formatted)
                entry["result_chars"] = len(formatted)
            except InvestigationError:
                raise
            except Exception as e:  # a tool error is the model's to read, not the end of the run
                result = json.dumps({"error": clean_error(e)})
                entry["error"] = clean_error(e)
        tool_log.append(entry)
        await write_audit(
            action="ai.tool.call",
            actor_user_id=ACTOR_ID,
            actor_email=ACTOR_EMAIL,
            target_type=args.get("resource_type") or "tool",
            target_id=args.get("resource_name") or args.get("name") or args.get("pod_name") or name,
            namespace=args.get("namespace") or row.namespace or None,
            cluster=perm.effective_cluster(service),
            after={
                "investigation_id": row.id,
                "tool": name,
                "iteration": step,
                "resource_type": args.get("resource_type"),
                "redacted": getattr(service.tool_server, "last_redacted", None),
            },
            result="failure" if entry.get("error") else "success",
            error=entry.get("error"),
        )
        return result

    turn = await run_tool_turn(service, messages, tools, run_tool, max_steps=cfg.max_steps,
                               final_message=inv_prompt.final_step_message(), remaining=remaining, lane="investigation")
    usage = turn.usage
    if not turn.answer:
        raise InvestigationError("the model returned no report")
    return {
        "report": turn.answer,
        "tool_calls": tool_log,
        "iterations": turn.steps,
        "provider": service.provider or "",
        "model": service.model or "",
        "prompt_tokens": usage["prompt_tokens"] if usage["seen"] else None,
        "completion_tokens": usage["completion_tokens"] if usage["seen"] else None,
        "total_tokens": usage["total_tokens"] if usage["seen"] else None,
    }


async def run_one(cfg: inv_settings.InvestigationSettings, db, row) -> str:
    started = time.monotonic()
    status, fields, error = "done", {}, ""
    try:
        fields = await investigate(cfg, row)
    except asyncio.TimeoutError:
        status, error = "failed", f"timed out after {cfg.timeout_seconds}s"
    except InvestigationError as e:
        status, error = "failed", str(e)
    except Exception as e:  # model or network failure: record it, keep the worker alive
        log.exception("investigation %s failed", row.id)
        status, error = "failed", f"{type(e).__name__}: {clean_error(e)}"
        refusal = classify(e)
        if refusal.blocks:  # credit, the key, a usage window: store.pause_reason holds the next runs back
            lifts = f", until {refusal.retry_at:%Y-%m-%dT%H:%M:%S}Z" if refusal.retry_at else ""
            error = f"{store.REFUSAL_PREFIX}{refusal.kind}{lifts}): {error}"
    duration_ms = int((time.monotonic() - started) * 1000)
    await store.finish(db, row.id, status=status, error=error, **fields)
    report = fields.get("report") or ""
    await write_audit(
        action="ai.investigation.run",
        actor_user_id=ACTOR_ID,
        actor_email=ACTOR_EMAIL,
        target_type="alert",
        target_id=row.fingerprint,
        namespace=row.namespace or None,
        cluster=row.cluster,
        result="success" if status == "done" else "failure",
        error=error or None,
        after={
            "investigation_id": row.id,
            "alertname": row.alertname,
            "severity": row.severity,
            "status": status,
            "provider": fields.get("provider"),
            "model": fields.get("model"),
            "prompt_tokens": fields.get("prompt_tokens"),
            "completion_tokens": fields.get("completion_tokens"),
            "total_tokens": fields.get("total_tokens"),
            "tool_calls": len(fields.get("tool_calls") or []),
            "iterations": fields.get("iterations"),
            "duration_ms": duration_ms,
            "summary": report[:SUMMARY_CHARS],
            "link": link_for(cfg, row.id),
        },
    )
    log.info("investigation %s %s in %dms", row.id, status, duration_ms)
    return status


async def fail_stale(cfg: inv_settings.InvestigationSettings, db) -> int:
    """Running rows older than the time limit belong to a process that stopped."""
    return await store.fail_stale_running(db, utcnow() - timedelta(seconds=cfg.timeout_seconds + 60))


async def worker(stop: asyncio.Event) -> None:
    log.info("alert investigation worker started")
    while not stop.is_set():
        cfg = inv_settings.load()
        try:
            db = await get_db_service()
            await fail_stale(cfg, db)
            row = await store.claim_next(db)
        except Exception:
            log.exception("investigation worker: queue unavailable")
            row = None
        if row is not None:
            reason = await store.pause_reason(db, cfg.provider_pause_minutes, utcnow())
            if reason:  # queued before the provider refused: it would be refused too
                await store.skip(db, row.id, reason)
            else:
                await run_one(cfg, db, row)
            continue
        webhook.wake.clear()
        try:
            await asyncio.wait_for(webhook.wake.wait(), timeout=POLL_SECONDS)
        except asyncio.TimeoutError:
            pass
    log.info("alert investigation worker stopped")
