"""One model turn that may call tools, for a caller with its own loop (the alert investigator).

The chat streams through app.services.ai.streaming, which has the same two branches. With an API key the loop
runs here: at most max_steps model calls, the last of which may call no tool so it must answer (as HolmesGPT does). On
provider claude-code Claude Code runs it (max_turns = max_steps - 1) and its tool calls come back to the same
run_tool; when it stops at that limit, one more call without tools writes the answer from the tool results.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, Sequence

from app.services.ai import limits
from app.services.ai import thought_signatures
from app.services.ai import tool_results
from app.services.ai import usage as usage_acct

# (tool name, arguments, step) -> the text the model reads back
ToolRunner = Callable[[str, dict, int], Awaitable[str]]

# The longest answer of a model call here, in tokens, when the model's options set none (limits.answer_tokens).
ANSWER_TOKENS = 2048


@dataclass
class ToolTurn:
    answer: str = ""
    steps: int = 0
    usage: dict[str, Any] = field(default_factory=usage_acct.new_turn_usage)
    # The provider's finish reason for the answer ("length": it stopped at the answer length), "" when it gave none.
    finish_reason: str = ""
    # On a subscription, what the tools returned as Claude Code's turn ran: the messages hold none of it.
    results: list[str] = field(default_factory=list)


def result_text(name: str, args: dict, text: str) -> str:
    """One tool result as tool_results_text lists it."""
    if tool_results.enabled():
        return tool_results.as_json(name, text, args)
    return f"{name} {json.dumps(args, ensure_ascii=False)}\n{text}"


def tool_results_text(results: Sequence[str]) -> str:
    """The tool results of a subscription's turn for a call that follows it without tools."""
    return "Tool results so far:\n\n" + "\n\n".join(results)


def server_calls(service, calls: Sequence[tuple[str, dict, str]]) -> list[dict[str, Any]]:
    """Reads the caller made before the first model call (the investigator's step 0), for the API-key path: one assistant
    message with the calls, then each answer as its tool message, the form run_tool_turn appends for the model's own calls,
    so what a cluster wrote reaches the model as a tool result. `calls`: (tool name, arguments, the text the model reads).
    Claude Code fills tool results only for the calls it makes: on a subscription the caller puts the answers in its request."""
    ids = [f"kubeast_step0_{n}" for n in range(1, len(calls) + 1)]
    return [
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False, sort_keys=True)}}
            for cid, (name, args, _text) in zip(ids, calls)
        ]},
        *({"role": "tool", "tool_call_id": cid, "content": tool_results.for_model(name, text, limits.tool_result_chars(service))}
          for cid, (name, _args, text) in zip(ids, calls)),
    ] if calls else []


def _finish(resp) -> str:
    return str(getattr(resp.choices[0], "finish_reason", None) or "")


def _args(raw: Optional[str]) -> dict:
    try:
        args = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    return args if isinstance(args, dict) else {}


def no_more_calls(service, tools: Sequence[dict]) -> dict[str, Any]:
    """What a call after a tool loop that may call no tool adds to its request: nothing (no tools), but on Anthropic the
    loop's own tools with tool_choice "none", since its thinking blocks are bound to the tools they were made with."""
    return dict(tools=tools, tool_choice="none") if tools and getattr(service, "provider", None) == "anthropic" else {}


async def run_tool_turn(service, messages: list[dict[str, Any]], tools: Sequence[dict], run_tool: ToolRunner, *,
                        max_steps: int, final_message: str, remaining: Callable[[], float],
                        lane: str = "chat", usage: Optional[dict[str, Any]] = None,
                        answer_tokens: int = ANSWER_TOKENS) -> ToolTurn:
    """`messages` grows with the API-key path's tool exchange; `remaining()` gives the seconds left (it raises
    once the caller's time is up). `usage` (usage.new_turn_usage) is added to as each model call answers, so a
    caller whose turn fails still has what the calls before used. `answer_tokens`: each API-key call's answer length
    when the model's options set none (any step's answer may be the report)."""
    out = ToolTurn() if usage is None else ToolTurn(usage=usage)
    if getattr(service, "provider", None) == "claude-code":
        return await _claude_code_turn(service, messages, tools, run_tool, max_steps=max_steps,
                                       final_message=final_message, remaining=remaining, lane=lane, out=out)
    for step in range(1, max_steps + 1):
        out.steps = step
        final = step == max_steps
        if final:
            messages.append({"role": "user", "content": final_message})
        kwargs: dict[str, Any] = dict(model=service.model, messages=messages, temperature=0.2,
                                 max_tokens=limits.answer_tokens(service, answer_tokens))
        if final:
            kwargs.update(no_more_calls(service, tools))
        elif tools:
            kwargs.update(tools=tools, tool_choice="auto")
        resp = await asyncio.wait_for(service.client.chat.completions.create(**kwargs, timeout=min(120.0, remaining())),
                                      timeout=remaining())
        usage_acct.add_usage(out.usage, getattr(resp, "usage", None),
                             prompt_chars=usage_acct.prompt_chars(messages, kwargs.get("tools")))
        msg = resp.choices[0].message
        calls = list(getattr(msg, "tool_calls", None) or []) if not final else []
        if not calls:
            out.answer = (msg.content or "").strip()
            out.finish_reason = _finish(resp)
            return out
        messages.append({
            "role": "assistant",
            "content": msg.content or "",
            "tool_calls": [
                {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments or "{}"},
                 **thought_signatures.kept(getattr(service, "provider", None), c)}
                for c in calls
            ],
        })
        for c in calls:
            result = await run_tool(c.function.name, _args(c.function.arguments), step)
            messages.append({"role": "tool", "tool_call_id": c.id, "content": tool_results.for_model(c.function.name, result, limits.tool_result_chars(service))})
    return out


async def answer_once(service, messages: list[dict[str, Any]], *, remaining: Callable[[], float], lane: str = "chat",
                      usage: Optional[dict[str, Any]] = None, answer_tokens: int = ANSWER_TOKENS,
                      tools: Sequence[dict] = ()) -> tuple[str, str]:
    """One more model call that may call no tool, after a turn (the investigator's rca block asks again with it): the
    API-key path's call, or Claude Code's plain completion on a subscription. Its tokens are added to `usage`.
    `tools`: the turn's (no_more_calls). (the answer, the provider's finish reason or "")."""
    if getattr(service, "provider", None) == "claude-code":
        done = await asyncio.wait_for(service.client.claude_code.complete(messages, lane=lane), timeout=remaining())
        if usage is not None:
            usage_acct.add_usage(usage, done.usage, prompt_chars=usage_acct.prompt_chars(messages, None))
        return (done.text or "").strip(), ""
    kept = no_more_calls(service, tools)
    resp = await asyncio.wait_for(
        service.client.chat.completions.create(model=service.model, messages=messages, temperature=0.2,
                                               max_tokens=limits.answer_tokens(service, answer_tokens),
                                               timeout=min(120.0, remaining()), **kept),
        timeout=remaining())
    if usage is not None:
        usage_acct.add_usage(usage, getattr(resp, "usage", None),
                             prompt_chars=usage_acct.prompt_chars(messages, kept.get("tools")))
    return (resp.choices[0].message.content or "").strip(), _finish(resp)


async def _claude_code_turn(service, messages, tools, run_tool, *, max_steps, final_message, remaining, lane,
                            out: Optional[ToolTurn] = None) -> ToolTurn:
    from app.services.claude_code import TurnResult

    out, cc = out if out is not None else ToolTurn(), TurnResult()
    results = out.results

    async def cc_tool(name: str, args: dict, step: int, call_id: Optional[int] = None):
        text = await run_tool(name, args, step)
        results.append(result_text(name, args, text))
        return [], tool_results.for_model(name, text, limits.tool_result_chars(service))

    prompt_chars = usage_acct.prompt_chars(messages, tools)
    async with asyncio.timeout(remaining()):
        async for _event in service.client.claude_code.turn(messages=messages, tools=tools, run_tool=cc_tool, out=cc,
                                                            turn_limit=max(1, max_steps - 1), lane=lane):
            pass  # the events are the chat's SSE; this caller keeps only the result
    usage_acct.add_usage(out.usage, cc.usage, prompt_chars=prompt_chars)
    out.usage["model_calls"] += max(0, cc.turns - 1)  # one run, cc.turns model calls
    out.steps = max(1, cc.turns)
    out.answer = cc.text.strip() if cc.finish_reason != "max_turns" else ""
    if out.answer:
        return out
    # Stopped at the limit (or no text): answer from what the tools returned, without tools.
    closing = messages + [{"role": "user", "content": tool_results_text(results) + "\n\n" + final_message}]
    done = await asyncio.wait_for(service.client.claude_code.complete(closing, lane=lane), timeout=remaining())
    usage_acct.add_usage(out.usage, done.usage, prompt_chars=usage_acct.prompt_chars(closing, None))
    out.steps += 1
    out.answer = done.text.strip()
    return out
