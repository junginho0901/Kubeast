"""One model turn that may call tools, for a caller with its own loop (the alert investigator).

The chat streams through app.services.ai.streaming, which has the same two branches. With an API key the loop
runs here: at most max_steps model calls, the last one without tools so it must answer (as HolmesGPT does). On
provider claude-code Claude Code runs it (max_turns = max_steps - 1) and its tool calls come back to the same
run_tool; when it stops at that limit, one more call without tools writes the answer from the tool results.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional, Sequence

from app.services.ai import usage as usage_acct

# (tool name, arguments, step) -> the text the model reads back
ToolRunner = Callable[[str, dict, int], Awaitable[str]]


@dataclass
class ToolTurn:
    answer: str = ""
    steps: int = 0
    usage: dict[str, Any] = field(default_factory=usage_acct.new_turn_usage)


def _args(raw: Optional[str]) -> dict:
    try:
        args = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    return args if isinstance(args, dict) else {}


async def run_tool_turn(service, messages: list[dict[str, Any]], tools: Sequence[dict], run_tool: ToolRunner, *,
                        max_steps: int, final_message: str, remaining: Callable[[], float],
                        lane: str = "chat") -> ToolTurn:
    """`messages` grows with the API-key path's tool exchange; `remaining()` gives the seconds left (it raises
    once the caller's time is up)."""
    if getattr(service, "provider", None) == "claude-code":
        return await _claude_code_turn(service, messages, tools, run_tool, max_steps=max_steps,
                                       final_message=final_message, remaining=remaining, lane=lane)
    out = ToolTurn()
    for step in range(1, max_steps + 1):
        out.steps = step
        final = step == max_steps
        if final:
            messages.append({"role": "user", "content": final_message})
        kwargs: dict[str, Any] = dict(model=service.model, messages=messages, temperature=0.2, max_tokens=2048)
        if not final and tools:
            kwargs.update(tools=tools, tool_choice="auto")
        resp = await asyncio.wait_for(service.client.chat.completions.create(**kwargs, timeout=min(120.0, remaining())),
                                      timeout=remaining())
        usage_acct.add_usage(out.usage, getattr(resp, "usage", None),
                             prompt_chars=usage_acct.prompt_chars(messages, kwargs.get("tools")))
        msg = resp.choices[0].message
        calls = list(getattr(msg, "tool_calls", None) or []) if not final else []
        if not calls:
            out.answer = (msg.content or "").strip()
            return out
        messages.append({
            "role": "assistant",
            "content": msg.content or "",
            "tool_calls": [
                {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments or "{}"}}
                for c in calls
            ],
        })
        for c in calls:
            result = await run_tool(c.function.name, _args(c.function.arguments), step)
            messages.append({"role": "tool", "tool_call_id": c.id, "content": result})
    return out


async def _claude_code_turn(service, messages, tools, run_tool, *, max_steps, final_message, remaining, lane) -> ToolTurn:
    from app.services.claude_code import TurnResult

    out, cc = ToolTurn(), TurnResult()
    results: list[str] = []

    async def cc_tool(name: str, args: dict, step: int):
        text = await run_tool(name, args, step)
        results.append(f"{name} {json.dumps(args, ensure_ascii=False)}\n{text}")
        return [], text

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
    closing = messages + [{"role": "user", "content": "Tool results so far:\n\n" + "\n\n".join(results) + "\n\n" + final_message}]
    done = await asyncio.wait_for(service.client.claude_code.complete(closing, lane=lane), timeout=remaining())
    usage_acct.add_usage(out.usage, done.usage, prompt_chars=usage_acct.prompt_chars(closing, None))
    out.steps += 1
    out.answer = done.text.strip()
    return out
