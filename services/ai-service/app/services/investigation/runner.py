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
first model call (investigation/windows.py). With any of rules, changes_first,
evidence_check or ledger on, each tool result the model reads starts with its call
number, step 0 being call 1 (investigation/numbers.py). With ai.refuseRepeatedReads a read
repeated within the run is not run again (app/services/ai/repeats.py). With
evidence_check or ledger on, the report ends with the rca block (investigation/rca.py):
the runner takes it out once, holds its causes to the run's calls (evidence_check,
investigation/evidence.py) and its hypotheses to their states (ledger,
investigation/ledger.py), asks once more without tools with every problem of both in
one message, and returns what it read as `result` (investigation/result.py). Its model
calls may then answer at rca.ANSWER_TOKENS, and the second ask is one more model call
than max_steps.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import timedelta
from typing import Any, Optional, Sequence
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
from app.services.investigation import ledger
from app.services.investigation import numbers
from app.services.investigation import rca
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
_USED = ("provider", "model", "prompt_tokens", "completion_tokens", "total_tokens")  # kept when the rest is refused


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


async def settle(service, messages: list[dict[str, Any]], answer: str, *, tool_log: list[dict[str, Any]],
                 reads: Optional[list], same_as: dict[int, int], row, cfg, remaining, usage: dict[str, Any],
                 progress: dict[str, Any], finish_reason: str = "",
                 tool_results: Sequence[str] = ()) -> tuple[str, dict[str, Any], int]:
    """The rca block, once for evidenceCheck and ledger (investigation/rca.py): (the report to keep, the row's
    `result`, the model calls it added — 0 or 1).

    The answer is split once and the checks of the switches that are on read that one block. While one finds a
    problem, one model call without tools asks for the report again with every problem of both in one message; its
    answer replaces the first only when it has a report with a heading before a block that can be read, and is checked
    the same way. A
    second call that fails or finds the time up leaves the first answer. With evidenceCheck the causes still not
    shown are listed under the report; with the ledger the hypotheses stay in `result` with their reasons. Each switch
    leaves its counts in `progress` for the run's audit row (`evidence`, `ledger`). `finish_reason`: the provider's
    for the answer. `tool_results`: a subscription's (ToolTurn.results), which its messages do not hold, so the
    second ask carries them as the closing call does."""
    from app.services.ai.tool_turn import answer_once, tool_results_text

    def check(text: str, finish: str) -> rca.Checked:
        return rca.check(text, tool_log=tool_log, reads=reads, alert_start=row.starts_at, evidence=cfg.evidence_check,
                         ledger=cfg.ledger, finish_reason=finish)

    first = kept = check(answer, finish_reason)
    asked = ask_failed = False
    if first.failures:
        asked = True
        ask = rca.ask_again(first, rca.rows(tool_log, same_as), evidence=cfg.evidence_check, ledger=cfg.ledger)
        if tool_results:
            ask = tool_results_text(tool_results) + "\n\n" + ask
        try:
            second, second_finish = await answer_once(
                service, messages + [{"role": "assistant", "content": answer}, {"role": "user", "content": ask}],
                remaining=remaining, lane="investigation", usage=usage, answer_tokens=rca.ANSWER_TOKENS)
        except Exception as e:  # the model or the clock: the first answer stands
            log.warning("investigation %s: the second ask failed: %s", row.id, clean_error(e))
            second, second_finish, ask_failed = "", "", True
        if second:
            again = check(second, second_finish)
            if again.status == "ok" and rca.has_report(second):  # a block alone, or with words around it, is no report
                kept = again
    report = kept.report
    if cfg.evidence_check:
        # unverified: the causes listed under the report; None when the kept report has no block to check
        progress["evidence"] = {"block": first.status, "causes": first.causes, "unsupported": len(first.cause_problems),
                                "asked_again": asked, "ask_failed": ask_failed, "block_after": kept.status,
                                "causes_after": kept.causes,
                                "unverified": len(kept.cause_problems) if kept.status == "ok" else None}
        if kept.status != "ok" or kept.cause_problems:
            report += evidence.note(kept.status, kept.cause_problems, cfg.language)
    if cfg.ledger:
        # the kept hypotheses counted and the failure kinds of both answers, no text
        progress["ledger"] = ledger.counts(kept.hypotheses, asked_because=first.failures, failures=kept.failures,
                                           asked_again=asked, ask_failed=ask_failed)
    result = inv_result.shape(kept.block, kept.status, tool_log, kept.hypotheses, asked_again=asked, ask_failed=ask_failed,
                              failures=kept.failures, cause_problems=kept.cause_problems if cfg.evidence_check else None,
                              checks={"evidence": cfg.evidence_check, "ledger": cfg.ledger})
    return report, result, int(asked)


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
    repeats = repeats_mod.RepeatGuard() if repeats_mod.enabled() else None
    # What each call returned to the model, by its place in tool_log, for the evidence check; kept only while the run lasts.
    reads: Optional[list[evidence.Read]] = [] if cfg.evidence_check else None
    same_as: dict[int, int] = {}  # a refused repeat's number → the number of the call it repeated
    numbered = numbers.on(cfg)  # each result the model reads starts with its call number

    async def call_tool(name: str, args: dict, step: int) -> tuple[str, Any, dict[str, Any]]:
        """The text the model reads, the tool's own answer (None when it did not run) and the call's log entry."""
        entry: dict[str, Any] = {"tool": name, "args": args, "step": step}
        ran, raw = False, None
        seen = None
        if name not in READONLY_TOOL_NAMES:
            result = json.dumps({"error": f"'{name}' is not a read-only tool; investigations only read"})
            entry["error"] = "not a read-only tool"
        elif repeats is not None and (seen := repeats.earlier(name, args)) is not None:
            # The same read answered earlier in this run: not run again, the model is told where its answer is.
            access_mod.reset(service)
            result = repeats_mod.refusal(seen, repeats.age(seen), scope="investigation", numbered=numbered)
            entry["repeat_of"] = seen.step
            if numbered and seen.call is not None:
                entry["repeat_of_call"] = seen.call  # the number the model read that call under
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
        if seen is not None and seen.call is not None:
            same_as[number] = seen.call
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
                # the call this one repeated (ai.refuseRepeatedReads), its iteration and with call numbers its number:
                # not run, nothing read
                **{k: entry[k] for k in ("repeat_of", "repeat_of_call") if k in entry},
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
        if read is not None:
            read.failed = bool(entry.get("error")) or (not ran and seen is None)
            read.text = result if ran and not read.failed else ""
        return result, raw, entry

    def number_of(entry: dict[str, Any]) -> int:
        """The call's place in tool_calls, from 1: the number the rca block gives it."""
        return next(i for i, e in enumerate(tool_log, 1) if e is entry)

    async def run_tool(name: str, args: dict, step: int) -> str:
        text, _raw, entry = await call_tool(name, args, step)
        return numbers.tag(number_of(entry), text) if numbered else text

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
        return inv_prompt.changes_block(numbers.tag(number_of(entry), text) if numbered else text, args)

    first: list[str] = []
    unused = ""  # why step 0 gave nothing to use
    if cfg.rules or cfg.changes_first:
        windows = inv_windows.of(row.starts_at, utcnow(), cfg)
        first.append(inv_windows.describe(windows, cfg))
        if cfg.changes_first:
            first.append(await changes_first(windows))
    system = inv_prompt.system_prompt(cluster=row.cluster, namespace=row.namespace, language=cfg.language, rules=cfg.rules)
    if rca.on(cfg):
        tail = rca.instruction(evidence=cfg.evidence_check, hypotheses=cfg.ledger)
    else:
        tail = numbers.NOTE if numbered else ""
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system + tail},
        {"role": "user", "content": inv_prompt.alert_message(cluster=row.cluster, alert=alert_view(row), context="\n\n".join(first))},
    ]
    final_message = inv_prompt.final_step_message(cfg.rules) + (rca.FINAL_NOTE if rca.on(cfg) else "")
    # With the block the answer is longer: every call may answer at rca.ANSWER_TOKENS (the model's own limit first).
    longer = {"answer_tokens": rca.ANSWER_TOKENS} if rca.on(cfg) else {}
    turn = await run_tool_turn(service, messages, tools, run_tool, max_steps=cfg.max_steps, final_message=final_message,
                               remaining=remaining, lane="investigation", usage=progress["usage"], **longer)
    usage = turn.usage
    if not turn.answer:
        raise InvestigationError("the model returned no report")
    answer, steps, extra = turn.answer, turn.steps, {}
    if rca.on(cfg):
        answer, extra["result"], asked = await settle(service, messages, answer, tool_log=tool_log, reads=reads,
                                                      same_as=same_as, row=row, cfg=cfg, remaining=remaining,
                                                      usage=usage, progress=progress, finish_reason=turn.finish_reason,
                                                      tool_results=turn.results)
        steps += asked
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
    calls, iterations = len(fields.get("tool_calls") or []), fields.get("iterations")
    try:
        await store.finish(db, row.id, status=status, error=error, **fields)
    except Exception as e:  # the row refused what the run wrote: failed (a failed run keeps its error), tokens counted
        log.exception("investigation %s: the run's fields could not be stored", row.id)
        if status == "done":
            error = f"the run's fields could not be stored: {type(e).__name__}: {clean_error(e)}"
        status, fields = "failed", {k: v for k, v in fields.items() if k in _USED}
        await store.finish(db, row.id, status=status, error=error, **fields)
    report = store.without_nul(fields.get("report") or "")
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
            "tool_calls": calls,
            "iterations": iterations,
            "duration_ms": duration_ms,
            "summary": report[:SUMMARY_CHARS],
            "link": link,
            # the person who asked for it in the Alerts inbox (ai.investigation.request); None for the webhook's
            "requested_by": getattr(row, "requested_by", "") or None,
            # features.alertInvestigation.evidenceCheck: what the check of the report's causes found (counts only)
            **({"evidence": progress["evidence"]} if progress.get("evidence") else {}),
            # features.alertInvestigation.ledger: the hypotheses by state and why it asked again (counts, kind names)
            **({"ledger": progress["ledger"]} if progress.get("ledger") else {}),
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
            try:
                reason = await claim_refusal(cfg, db, row, utcnow())
                if reason:  # queued before the provider refused or the budget was spent: it would cross it too
                    await store.skip(db, row.id, reason)
                else:
                    await run_one(cfg, db, row)
            except Exception:  # the store or the audit refused the run's end: fail_stale fails the row, the next ones run
                log.exception("investigation %s: not finished", row.id)
            continue
        webhook.wake.clear()
        try:
            await asyncio.wait_for(webhook.wake.wait(), timeout=POLL_SECONDS)
        except asyncio.TimeoutError:
            pass
    log.info("alert investigation worker stopped")
