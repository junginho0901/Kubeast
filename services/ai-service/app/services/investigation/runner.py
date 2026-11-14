"""The worker and one investigation.

The worker runs only while features.alertInvestigation is on. It claims the
oldest queued row, asks auth-service for the investigator's token for that
cluster (and the alert's namespace), and runs the read-only tools through the
same path the chat uses — tool-server checks the token's ai.tool.* rights and
namespace, the cluster sees kubeast:investigator. At most max_steps model calls;
the last one gets no tools, so it must answer (as HolmesGPT does) — the loop is
app.services.ai.tool_turn, which hands it to Claude Code on a Claude subscription.
The whole run is bounded by timeout_seconds. With ai.refuseRepeatedReads a read
repeated within the run is not run again (app/services/ai/repeats.py); with
evidence_check the report's causes are held to the run's calls before it is kept
(investigation/evidence.py).
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
from app.services.ai import repeats as repeats_mod
from app.services.investigation import evidence
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import settings as inv_settings
from app.services.investigation import inbox, skip_reasons, store
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


async def verify_report(service, messages: list[dict[str, Any]], answer: str, reads: list, row, cfg, *, remaining,
                        usage: dict[str, Any], progress: dict[str, Any]) -> tuple[str, int]:
    """The evidence check (investigation/evidence.py): (the report to keep, the model calls it added — 0 or 1).

    A cause that no call of the run shows, or a report without its rca block, gets one more model call without tools
    asking for the report again; its answer replaces the first only when it ends with a valid block. What still fails
    is listed under the report. The block is taken out of the kept report. A second call that fails or finds the time
    up leaves the first answer with that list."""
    from app.services.ai.tool_turn import answer_once

    report, block, status = evidence.split(answer)
    causes, problems = evidence.check(block, reads, row.starts_at) if block is not None else (0, [])
    summary: dict[str, Any] = {"block": status, "causes": causes, "unsupported": len(problems), "asked_again": False}
    if status == "ok" and not problems:
        progress["evidence"] = {**summary, "block_after": status, "causes_after": causes, "unverified": 0}
        return report, 0
    summary["asked_again"] = True
    again = messages + [{"role": "assistant", "content": answer},
                        {"role": "user", "content": evidence.ask_again(status, problems, reads)}]
    try:
        second = await answer_once(service, again, remaining=remaining, lane="investigation", usage=usage)
    except Exception as e:  # the model or the clock: the first answer stands, with what was not verified
        log.warning("investigation %s: the evidence check's second call failed: %s", row.id, clean_error(e))
        second = ""
    if second:
        report2, block2, status2 = evidence.split(second)
        if block2 is not None:
            report, status = report2, status2
            causes, problems = evidence.check(block2, reads, row.starts_at)
    # unverified: the causes listed under the report; None when the kept report has no block to check
    progress["evidence"] = {**summary, "block_after": status, "causes_after": causes,
                            "unverified": len(problems) if status == "ok" else None}
    if status == "ok" and not problems:
        return report, 1
    return report + evidence.note(status, problems, cfg.language), 1


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
    system = inv_prompt.system_prompt(cluster=row.cluster, namespace=row.namespace, language=cfg.language)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system + (evidence.INSTRUCTION if cfg.evidence_check else "")},
        {"role": "user", "content": inv_prompt.alert_message(cluster=row.cluster, alert=alert_view(row))},
    ]
    tool_log: list[dict[str, Any]] = []
    repeats = repeats_mod.RepeatGuard() if repeats_mod.enabled() else None
    # What each call returned to the model, by its place in tool_log, for the evidence check; kept only while the run lasts.
    reads: Optional[list[evidence.Read]] = [] if cfg.evidence_check else None

    async def run_tool(name: str, args: dict, step: int) -> str:
        entry: dict[str, Any] = {"tool": name, "args": args, "step": step}
        ran = False
        seen = None
        if name not in READONLY_TOOL_NAMES:
            result = json.dumps({"error": f"'{name}' is not a read-only tool; investigations only read"})
            entry["error"] = "not a read-only tool"
        elif repeats is not None and (seen := repeats.earlier(name, args)) is not None:
            # The same read answered earlier in this run: not run again, the model is told where its answer is.
            access_mod.reset(service)
            result = repeats_mod.refusal(seen, repeats.age(seen), scope="investigation")
            entry["repeat_of"] = seen.step
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
        number = len(tool_log)  # the call's number, before another call can append
        read = None
        if reads is not None:
            read = evidence.Read(name, args, same_as=seen.call if seen is not None else None)
            reads.append(read)
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
                # the iteration of the call this one repeated (ai.refuseRepeatedReads): not run, nothing read
                **({"repeat_of": seen.step} if seen is not None else {}),
            },
            result="failure" if entry.get("error") else "success",
            error=entry.get("error"),
        )
        if stored is False and ran and fail_closed_enabled():
            # As on the screens, a read nobody could find later gives no answer.
            entry["error"] = "audit unavailable"
            result = json.dumps({"status": "audit_unavailable"})
        if repeats is not None and ran and not entry.get("error"):
            repeats.note(name, args, step=step, call=number)
        if read is None:
            return result
        read.failed = bool(entry.get("error")) or (not ran and seen is None)
        read.text = result if ran and not read.failed else ""
        return evidence.tag(number, result)

    final_message = inv_prompt.final_step_message() + (evidence.FINAL_NOTE if reads is not None else "")
    turn = await run_tool_turn(service, messages, tools, run_tool, max_steps=cfg.max_steps,
                               final_message=final_message, remaining=remaining, lane="investigation",
                               usage=progress["usage"])
    usage = turn.usage
    if not turn.answer:
        raise InvestigationError("the model returned no report")
    report, steps = turn.answer, turn.steps
    if reads is not None:
        report, asked = await verify_report(service, messages, turn.answer, reads, row, cfg, remaining=remaining,
                                            usage=usage, progress=progress)
        steps += asked
    return {
        "report": report,
        "tool_calls": tool_log,
        "iterations": steps,
        "provider": service.provider or "",
        "model": service.model or "",
        "prompt_tokens": usage["prompt_tokens"] if usage["seen"] else None,
        "completion_tokens": usage["completion_tokens"] if usage["seen"] else None,
        "total_tokens": usage["total_tokens"] if usage["seen"] else None,
    }


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
            # features.alertInvestigation.evidenceCheck: what the check of the report's causes found (counts only)
            **({"evidence": progress["evidence"]} if progress.get("evidence") else {}),
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
