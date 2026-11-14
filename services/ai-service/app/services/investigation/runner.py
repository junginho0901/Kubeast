"""The worker and one investigation.

The worker runs only while features.alertInvestigation is on. It claims the
oldest queued row, asks auth-service for the investigator's token for that
cluster (and the alert's namespace), and runs the read-only tools through the
same path the chat uses — tool-server checks the token's ai.tool.* rights and
namespace, the cluster sees kubeast:investigator. At most max_steps model calls;
the last one gets no tools, so it must answer (as HolmesGPT does) — the loop is
app.services.ai.tool_turn, which hands it to Claude Code on a Claude subscription.
The whole run is bounded by timeout_seconds. With rules or changes_first on, the
first message also holds the time windows counted from the alert's start, and
with changes_first what changed in the change window, read as step 0 before the
first model call (investigation/windows.py). With ledger on, each tool result the model reads carries its call
number and the report ends with the rca block: the runner takes it out, asks once more without tools while a
hypothesis is open, and returns what it read as `result` (investigation/result.py, investigation/ledger.py).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import timedelta
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

from app.database import get_db_service, utcnow
from app.services.ai import access as access_mod
from app.services.ai import limits
from app.services.ai.debug_dump import safe_error
from app.services.ai.model_errors import classify
from app.services.audit_target import tool_target
from app.services.audit_writer import audit_ready, fail_closed_enabled, write_audit
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import settings as inv_settings
from app.services.investigation import inbox, skip_reasons, store
from app.services.investigation import ledger as inv_ledger
from app.services.investigation import result as inv_result
from app.services.investigation import webhook
from app.services.investigation import windows as inv_windows

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
        installer_base_url=resolved.installer_base_url,
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


async def link_for(cfg: inv_settings.InvestigationSettings, db, row) -> Optional[str]:
    """Where the audit summary's link goes: the alert's window in Alerts, which whoever reads the cluster can open, the
    report inside it. Without the alert's row, the report in Investigations, for those who hold that."""
    if not cfg.console_url:
        return None
    try:
        item = await inbox.row_of(db, row)
    except Exception as e:  # the link is not worth the run's audit row
        log.warning("investigation %s: no alert row for the link: %s", row.id, clean_error(e))
        item = None
    if item is None:
        return f"{cfg.console_url}/admin/investigations?id={row.id}"
    return f"{cfg.console_url}/alerts?{urlencode({'cluster': row.cluster, 'alert': item.id})}"


def used_fields(progress: dict[str, Any]) -> dict[str, Any]:
    """What a run that failed had used: the provider and model it built and the tokens its model calls reported."""
    usage = progress.get("usage") or {}
    out: dict[str, Any] = {k: progress[k] for k in ("provider", "model") if progress.get(k)}
    if usage.get("seen"):
        out.update(prompt_tokens=usage["prompt_tokens"], completion_tokens=usage["completion_tokens"], total_tokens=usage["total_tokens"])
    return out


async def investigate(cfg: inv_settings.InvestigationSettings, row, progress: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Run one investigation; return the fields to store. Raises on failure — `progress` then holds what it had used
    (the provider, the model and the model calls' usage), for used_fields."""
    from app.services.ai import formatters
    from app.services.ai import permissions as perm
    from app.services.ai import usage as usage_acct
    from app.services.ai.streaming import tool_outcome
    from app.services.ai.tool_turn import run_tool_turn
    from app.services.ai_service import ToolContext
    from app.services.tool_whitelists import READONLY_TOOL_NAMES, readonly_tool_filter

    progress = progress if progress is not None else {}
    progress["usage"] = usage_acct.new_turn_usage()
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
    progress.update(provider=service.provider or "", model=service.model or "")
    from app.services.ai import features as feature_gate
    tools = await feature_gate.gate_tools(readonly_tool_filter(service._get_tools_definition()), service)
    context = ToolContext(session_id=f"investigation:{row.id}")
    tool_log: list[dict[str, Any]] = []

    async def call_tool(name: str, args: dict, step: int) -> tuple[str, Any, dict[str, Any]]:
        """The text the model reads, the tool's own answer (None when it did not run) and the call's log entry."""
        entry: dict[str, Any] = {"tool": name, "args": args, "step": step}
        ran, raw = False, None
        if name not in READONLY_TOOL_NAMES:
            result = json.dumps({"error": f"'{name}' is not a read-only tool; investigations only read"})
            entry["error"] = "not a read-only tool"
        elif not (await audit_ready())[0]:
            result = json.dumps({"status": "audit_unavailable"})
            entry["error"] = "audit unavailable"
        else:
            ran = True
            access_mod.reset(service)
            try:
                raw = await asyncio.wait_for(service._execute_function_with_context(name, args, context), timeout=remaining())
                formatted, _is_json, _is_yaml = formatters._format_tool_result(name, args, raw)
                result = formatters._truncate_tool_result_for_llm(formatted, limits.tool_result_chars(service), tool=name)
                entry["result_chars"] = len(formatted)
                # a refusal or an error the tool answered with, read as the chat reads it
                _outcome, problem, _status = tool_outcome(raw)
                if problem:
                    entry["error"] = problem
            except InvestigationError:
                raise
            except Exception as e:  # a tool error is the model's to read, not the end of the run
                result = json.dumps({"error": clean_error(e)})
                entry["error"] = clean_error(e)
            if (access := access_mod.of_call(service, name)) is not None:
                entry["access"] = access
            if (requests := access_mod.requests_of_call(service)) is not None:
                entry["requests"] = requests
        tool_log.append(entry)
        target = tool_target(name, args)
        stored = await write_audit(
            action="ai.tool.call",
            actor_user_id=ACTOR_ID,
            actor_email=ACTOR_EMAIL,
            target_type=target.type,
            target_id=target.id,
            namespace=target.namespace or row.namespace or None,
            cluster=perm.effective_cluster(service),
            after={
                "investigation_id": row.id,
                "tool": name,
                "iteration": step,
                "resource_type": args.get("resource_type"),
                "redacted": getattr(service.tool_server, "last_redacted", None),
                "access": entry.get("access"),
                "requests": entry.get("requests"),
            },
            result="failure" if entry.get("error") else "success",
            error=entry.get("error"),
        )
        if stored is False and ran and fail_closed_enabled():
            # As on the screens, a read nobody could find later gives no answer.
            entry["error"] = "audit unavailable"
            return json.dumps({"status": "audit_unavailable"}), raw, entry
        return result, raw, entry

    def number_of(entry: dict[str, Any]) -> int:
        """The call's place in tool_calls, from 1: the number the rca block gives it."""
        return next(i for i, e in enumerate(tool_log, 1) if e is entry)

    async def run_tool(name: str, args: dict, step: int) -> str:
        text, _raw, entry = await call_tool(name, args, step)
        return inv_result.tag(number_of(entry), text) if cfg.ledger else text

    async def changes_first(windows: inv_windows.Windows) -> str:
        """Step 0: the changes view through the same call as the model's (rights, masking, limits, audit row), no model
        step spent. Without it the investigation goes on and the report says why."""
        nonlocal unused
        offered = {(t.get("function") or {}).get("name") for t in tools}
        if inv_windows.CHANGES_TOOL not in offered:
            unused = f"{inv_windows.CHANGES_TOOL} is not offered to this investigation"
            return inv_prompt.no_changes_block(unused)
        args = inv_windows.changes_args(windows, row.namespace)
        text, raw, entry = await call_tool(inv_windows.CHANGES_TOOL, args, 0)
        if entry.get("error"):
            unused = f"{inv_windows.CHANGES_TOOL} answered: {entry['error']}"
        elif not inv_windows.is_changes_answer(raw):
            unused = f"{inv_windows.CHANGES_TOOL} did not answer the {inv_windows.CHANGES_VIEW} view"
        if unused:
            return inv_prompt.no_changes_block(unused)
        return inv_prompt.changes_block(inv_result.tag(number_of(entry), text) if cfg.ledger else text, args)

    first: list[str] = []
    unused = ""  # why step 0 gave nothing to use
    if cfg.rules or cfg.changes_first:
        windows = inv_windows.of(row.starts_at, utcnow(), cfg)
        first.append(inv_windows.describe(windows, cfg))
        if cfg.changes_first:
            first.append(await changes_first(windows))
    system = inv_prompt.system_prompt(cluster=row.cluster, namespace=row.namespace, language=cfg.language, rules=cfg.rules)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system + (inv_ledger.INSTRUCTION if cfg.ledger else "")},
        {"role": "user", "content": inv_prompt.alert_message(cluster=row.cluster, alert=alert_view(row), context="\n\n".join(first))},
    ]
    turn = await run_tool_turn(service, messages, tools, run_tool, max_steps=cfg.max_steps,
                               final_message=inv_prompt.final_step_message(cfg.rules) + (inv_ledger.FINAL_NOTE if cfg.ledger else ""),
                               remaining=remaining, lane="investigation", usage=progress["usage"])
    usage = turn.usage
    if not turn.answer:
        raise InvestigationError("the model returned no report")
    answer, steps, extra = turn.answer, turn.steps, {}
    if cfg.ledger:
        answer, result, asked = await settle_result(service, messages, turn.answer, tool_log, remaining, progress["usage"], row.id)
        steps += 1 if asked else 0
        extra["result"] = result
    return {
        "report": answer + (inv_prompt.step_zero_note(unused, cfg.language) if unused else ""),
        "tool_calls": tool_log,
        "iterations": steps,
        "provider": service.provider or "",
        "model": service.model or "",
        "prompt_tokens": usage["prompt_tokens"] if usage["seen"] else None,
        "completion_tokens": usage["completion_tokens"] if usage["seen"] else None,
        "total_tokens": usage["total_tokens"] if usage["seen"] else None,
        **extra,
    }


async def answer_without_tools(service, messages: list[dict[str, Any]], remaining, usage: dict[str, Any]) -> str:
    """One more model call with no tools offered, on either loop's provider; its tokens count in the run's usage."""
    from app.services.ai import usage as usage_acct

    if getattr(service, "provider", None) == "claude-code":
        done = await asyncio.wait_for(service.client.claude_code.complete(messages, lane="investigation"), timeout=remaining())
        usage_acct.add_usage(usage, done.usage, prompt_chars=usage_acct.prompt_chars(messages, None))
        return (done.text or "").strip()
    resp = await asyncio.wait_for(
        service.client.chat.completions.create(model=service.model, messages=messages, temperature=0.2,
                                               max_tokens=limits.answer_tokens(service, 2048), timeout=min(120.0, remaining())),
        timeout=remaining())
    usage_acct.add_usage(usage, getattr(resp, "usage", None), prompt_chars=usage_acct.prompt_chars(messages, None))
    return (resp.choices[0].message.content or "").strip()


async def settle_result(service, messages: list[dict[str, Any]], answer: str, tool_log: list[dict[str, Any]], remaining,
                        usage: dict[str, Any], inv_id: str) -> tuple[str, dict[str, Any], bool]:
    """(the report without its rca block, the row's result, whether the model was asked again). A report whose block
    is missing or holds a hypothesis that is not closed is asked for once more without tools; the second answer is
    taken when its block can be read. A second call that fails keeps the first report."""
    report, block, status = inv_result.split(answer)
    hypotheses = inv_ledger.check(block, tool_log)
    if not inv_ledger.needs_asking(status, block, hypotheses):
        return report, inv_result.shape(block, status, tool_log, hypotheses), False
    ask = inv_ledger.ask_again(status, block, hypotheses, tool_log)
    try:
        again = await answer_without_tools(
            service, messages + [{"role": "assistant", "content": answer}, {"role": "user", "content": ask}], remaining, usage)
    except Exception as e:  # the report is there; the second ask is not worth the run
        log.warning("investigation %s: second ask failed: %s", inv_id, clean_error(e))
        return report, inv_result.shape(block, status, tool_log, hypotheses, asked_again=True, ask_failed=True), True
    report2, block2, status2 = inv_result.split(again)
    if status2 == "ok" and report2.strip():
        report, block, status = report2, block2, status2
        hypotheses = inv_ledger.check(block, tool_log)
    return report, inv_result.shape(block, status, tool_log, hypotheses, asked_again=True), True


async def run_one(cfg: inv_settings.InvestigationSettings, db, row) -> str:
    started = time.monotonic()
    status, fields, error = "done", {}, ""
    progress: dict[str, Any] = {}
    try:
        fields = await investigate(cfg, row, progress)
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
    if status == "failed":  # the tokens used before it failed count in the daily budget and AI usage too
        fields = used_fields(progress)
    duration_ms = int((time.monotonic() - started) * 1000)
    await store.finish(db, row.id, status=status, error=error, **fields)
    report = fields.get("report") or ""
    link = await link_for(cfg, db, row)
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
            "link": link,
            # the person who asked for it in the Alerts inbox (ai.investigation.request); None for the webhook's
            "requested_by": getattr(row, "requested_by", "") or None,
        },
    )
    log.info("investigation %s %s in %dms", row.id, status, duration_ms)
    return status


async def claim_refusal(cfg: inv_settings.InvestigationSettings, db, row, now) -> str:
    """Why a row the worker took does not run now, or "": its kind was switched off, the model provider refused since
    it was queued, or its kind's daily token budget was spent since. The rows queued before it ran first and count
    by now, so the budget holds to within the one run that crosses it (per worker)."""
    manual = bool(getattr(row, "requested_by", ""))
    if not (cfg.manual if manual else cfg.automatic):
        return skip_reasons.switched_off(manual)
    reason = await store.pause_reason(db, cfg.provider_pause_minutes, now)
    if reason:
        return reason
    budget = cfg.manual_daily_token_budget if manual else cfg.daily_token_budget
    if budget and await store.tokens_since(db, store.day_start(now), manual=manual) >= budget:
        return skip_reasons.manual_daily_token_budget(budget) if manual else skip_reasons.daily_token_budget(budget)
    return ""


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
            reason = await claim_refusal(cfg, db, row, utcnow())
            if reason:  # queued before the provider refused or the budget was spent: it would cross it too
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
