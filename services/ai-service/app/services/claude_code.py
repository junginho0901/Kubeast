"""Claude subscription (``claude setup-token``) as a chat model — provider ``claude-code``.

A Claude Pro/Max subscription's token authenticates only Claude Code, so this provider hands each model call
to Claude Code through the Claude Agent SDK (pip ``claude-agent-sdk``, which carries the Claude Code binary):

* a plain completion (history notes, the Optimization explanation): no tools;
* a chat turn: Claude Code runs the model loop, and each tool call it makes is answered by a function in
  this process that runs the chat's own tool code — the same tools, approval card for writes, masking and
  ``ai.tool.call`` audit as with an API key;
* an alert investigation: the same turn with the investigator's read-only tools (app.services.ai.tool_turn).

Every run is isolated: a temporary HOME and config directory, only that tool server, no built-in tools, no
settings files, and every variable this service inherited blanked except PATH, locale and proxy settings,
so the model keys and the database URL never reach it. The token reaches it only as
``CLAUDE_CODE_OAUTH_TOKEN``. Off by default (``AI_CLAUDE_CODE_ENABLED``, chart
``ai.providers.claudeCode.enabled``) and meant for an install one person uses with their own subscription:
Anthropic's terms keep subscriptions to individual use. Runs wait for a free slot: the chat's
(``AI_CLAUDE_CODE_MAX_CONCURRENT``) or the investigator's own one, so an investigation never holds up a chat.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from collections import deque
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, AsyncIterator, Awaitable, Callable, Optional, Sequence

from app.config import settings

log = logging.getLogger(__name__)

PROVIDER = "claude-code"
TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN"
TOOL_SERVER = "kubeast"
TOOL_PREFIX = f"mcp__{TOOL_SERVER}__"
STDERR_LINES = 20
# What the CLI keeps from this service's environment (paths and network settings); everything else is blanked.
KEEP_ENV = frozenset({"PATH", "LANG", "LC_ALL", "TZ", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
                      "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"})

# (tool name, arguments, model turn) → (chat SSE events after the call, the result text the model reads)
ToolRunner = Callable[[str, dict, int], Awaitable[tuple[list[str], str]]]

# Concurrency lanes: "chat" (chat, floating assistant, plain completions) and "investigation" (one worker, one run).
_semaphores: dict[str, asyncio.Semaphore] = {}


class ClaudeCodeError(RuntimeError):
    """Claude Code is off or missing, refused the token, or ended without an answer."""


def enabled() -> bool:
    return bool(getattr(settings, "AI_CLAUDE_CODE_ENABLED", False))


def max_concurrent() -> int:
    return max(1, int(getattr(settings, "AI_CLAUDE_CODE_MAX_CONCURRENT", 1) or 1))


def turn_timeout() -> float:
    return float(max(30, int(getattr(settings, "AI_CLAUDE_CODE_TURN_TIMEOUT", 300) or 300)))


def max_turns() -> int:
    return max(1, int(getattr(settings, "AI_CLAUDE_CODE_MAX_TURNS", 10) or 10))


def _sdk():
    """The Claude Agent SDK, or None in an image built without it."""
    try:
        import claude_agent_sdk
    except ImportError:
        return None
    return claude_agent_sdk


def unavailable_reason() -> Optional[str]:
    """Why the provider cannot run here, or None."""
    if not enabled():
        return "the Claude subscription provider is off (chart ai.providers.claudeCode.enabled)"
    if _sdk() is None:
        return "Claude Code is not in this ai-service image (build it with --build-arg WITH_CLAUDE_CODE=true)"
    return None


def _sem(lane: str = "chat") -> asyncio.Semaphore:
    if lane not in _semaphores:
        _semaphores[lane] = asyncio.Semaphore(max_concurrent() if lane == "chat" else 1)
    return _semaphores[lane]


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(p.get("text", "")) for p in content if isinstance(p, dict) and p.get("type") == "text")
    return "" if content is None else str(content)


def split_messages(messages: Sequence[dict]) -> tuple[str, str]:
    """OpenAI-style messages → (system prompt, prompt). System parts join the system prompt; the rest
    becomes a transcript whose last user message is the request."""
    system_parts, turns = [], []
    for m in messages:
        role = m.get("role")
        text = _content_text(m.get("content"))
        if role == "system":
            system_parts.append(text)
        elif role in ("user", "assistant") and text:
            turns.append((role, text))
    if not turns:
        return "\n\n".join(system_parts), ""
    *earlier, last = turns
    if not earlier and last[0] == "user":
        return "\n\n".join(system_parts), last[1]
    lines = [f"{'User' if r == 'user' else 'Assistant'}: {t}" for r, t in earlier]
    request = last[1] if last[0] == "user" else ""
    prompt = "Conversation so far:\n<<<\n" + "\n\n".join(lines) + "\n>>>\n\n"
    prompt += ("Current request:\n" + request) if request else "Continue."
    return "\n\n".join(system_parts), prompt


def _ca_bundle(workdir: str) -> Optional[str]:
    """Claude Code reads one extra-CA file: the mounted custom CAs (CUSTOM_CA_DIR) joined into one, after
    an extra-CA file this service was already given."""
    from app.services.tls import _custom_ca_files
    files = _custom_ca_files()
    if not files:
        return None
    inherited = os.environ.get("NODE_EXTRA_CA_CERTS", "")
    files = ((inherited,) if inherited and os.path.isfile(inherited) else ()) + tuple(files)
    path = os.path.join(workdir, "ca.pem")
    with open(path, "w", encoding="utf-8") as out:
        for f in files:
            with open(f, encoding="utf-8", errors="ignore") as src:
                out.write(src.read().rstrip() + "\n")
    return path


def child_env(token: str, workdir: str) -> dict[str, str]:
    """The CLI's environment. The SDK starts from this process's environment and lays this over it, so
    every inherited variable outside KEEP_ENV is set empty here (an empty ANTHROPIC_API_KEY counts as unset)."""
    env = {k: "" for k in os.environ if k not in KEEP_ENV}
    env.update({
        "HOME": workdir,
        "CLAUDE_CONFIG_DIR": workdir,
        TOKEN_ENV: token,
        "DISABLE_AUTOUPDATER": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        # every tool definition goes with every call, as on the API-key path
        "ENABLE_TOOL_SEARCH": "false",
    })
    ca = _ca_bundle(workdir)
    if ca:
        env["NODE_EXTRA_CA_CERTS"] = ca
    return env


def _options(sdk, *, model: str, system_prompt: str, token: str, workdir: str, server=None,
             allowed: Sequence[str] = (), turns: int = 1, stderr: Optional[Callable[[str], None]] = None,
             partial: bool = False):
    return sdk.ClaudeAgentOptions(
        include_partial_messages=partial,  # StreamEvents: the answer as it is written
        model=model,
        system_prompt=system_prompt or "",
        tools=[],              # no built-in tools (Bash, Read, Edit, web …)
        setting_sources=[],    # no settings, CLAUDE.md or plugins from any directory
        strict_mcp_config=True,
        mcp_servers={TOOL_SERVER: server} if server is not None else {},
        allowed_tools=list(allowed),
        max_turns=turns,
        cwd=workdir,
        env=child_env(token, workdir),
        stderr=stderr,
    )


def usage_of(usage: Optional[dict]) -> dict[str, Any]:
    """The run's usage as an OpenAI-style usage (what app.services.ai.usage sums)."""
    u = usage or {}
    cached = int(u.get("cache_read_input_tokens") or 0)
    created = int(u.get("cache_creation_input_tokens") or 0)
    prompt = int(u.get("input_tokens") or 0) + cached + created
    completion = int(u.get("output_tokens") or 0)
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion,
            "prompt_tokens_details": {"cached_tokens": cached}, "cache_creation_input_tokens": created}


def _failure(err: Exception, stderr: deque) -> ClaudeCodeError:
    from app.services.redact import redact_text
    text = str(err) or type(err).__name__
    tail = " | ".join(stderr)
    message, _ = redact_text(f"{text}: {tail}" if tail else text)
    return ClaudeCodeError(f"Claude Code failed: {message.strip()[:600]}")


def _result_error(result) -> Optional[ClaudeCodeError]:
    """An error result as an exception; None for a successful one or a run cut off at max turns."""
    if not getattr(result, "is_error", False) or result.subtype == "error_max_turns":
        return None
    from app.services.redact import redact_text
    detail = result.result or "; ".join(result.errors or []) or result.subtype
    status = f" (HTTP {result.api_error_status})" if getattr(result, "api_error_status", None) else ""
    message, _ = redact_text(str(detail))
    return ClaudeCodeError(f"Claude Code{status}: {message.strip()[:600]}")


async def _run(sdk, prompt: str, options, on_message: Callable[[Any], None], stderr: deque, lane: str = "chat"):
    """One Claude Code run within its lane's concurrency limit and the turn timeout; returns its result message."""
    result = None
    async with _sem(lane):
        try:
            async with asyncio.timeout(turn_timeout()):
                async for message in sdk.query(prompt=prompt, options=options):
                    if isinstance(message, sdk.ResultMessage):
                        result = message
                    else:
                        on_message(message)
        except TimeoutError:
            raise ClaudeCodeError(f"Claude Code did not finish within {int(turn_timeout())} s") from None
        except ClaudeCodeError:
            raise
        except Exception as e:
            if result is None:  # after an error result the SDK raises too: the result says more
                raise _failure(e, stderr) from None
    if result is None:
        raise ClaudeCodeError("Claude Code ended without a result")
    error = _result_error(result)
    if error:
        raise error
    return result


@dataclass
class Completion:
    text: str = ""
    usage: Optional[dict] = None


async def complete(messages: Sequence[dict], *, model: str, token: str, lane: str = "chat") -> Completion:
    """One plain completion: no tools."""
    reason = unavailable_reason()
    if reason:
        raise ClaudeCodeError(reason)
    sdk = _sdk()
    system_prompt, prompt = split_messages(messages)
    stderr: deque = deque(maxlen=STDERR_LINES)
    with tempfile.TemporaryDirectory(prefix="kubeast-cc-") as workdir:
        options = _options(sdk, model=model, system_prompt=system_prompt, token=token, workdir=workdir,
                           stderr=stderr.append)
        result = await _run(sdk, prompt, options, lambda _m: None, stderr, lane)
    return Completion(text=str(result.result or ""), usage=usage_of(result.usage))


class _TextPieces:
    """The answer's text as it is written: each text_delta StreamEvent as it comes, with a blank line where a
    text block starts after earlier text (the paragraphs the API-key path shows). An assistant message whose text
    came as deltas is not sent again; one without deltas is sent whole."""

    def __init__(self, sdk):
        self._sdk = sdk
        self._sent = False       # some text went out
        self._new_block = False  # the next piece opens a text block
        self._deltas = False     # text deltas since the last assistant message

    def feed(self, message) -> list[str]:
        sdk = self._sdk
        if isinstance(message, sdk.StreamEvent):
            event = message.event or {}
            kind = event.get("type")
            if kind == "content_block_start" and (event.get("content_block") or {}).get("type") == "text":
                self._new_block = True
            elif kind == "content_block_delta" and (event.get("delta") or {}).get("type") == "text_delta":
                text = event["delta"].get("text") or ""
                if text:
                    self._deltas = True
                    return [self._piece(text)]
            return []
        if not isinstance(message, sdk.AssistantMessage):
            return []
        pieces = []
        if not self._deltas:
            for block in message.content:
                if isinstance(block, sdk.TextBlock) and block.text:
                    self._new_block = True
                    pieces.append(self._piece(block.text))
        self._deltas = False
        return pieces

    def _piece(self, text: str) -> str:
        sep = "\n\n" if self._new_block and self._sent else ""
        self._new_block, self._sent = False, True
        return sep + text


async def stream_complete(messages: Sequence[dict], *, model: str, token: str, lane: str = "chat") -> AsyncIterator[Any]:
    """One plain completion as it is written: yields the text pieces (str), then the Completion."""
    reason = unavailable_reason()
    if reason:
        raise ClaudeCodeError(reason)
    sdk = _sdk()
    system_prompt, prompt = split_messages(messages)
    pieces = _TextPieces(sdk)
    queue: asyncio.Queue = asyncio.Queue()
    done = object()

    def on_message(message) -> None:
        for piece in pieces.feed(message):
            queue.put_nowait(("text", piece))

    async def pump() -> None:
        stderr: deque = deque(maxlen=STDERR_LINES)
        try:
            with tempfile.TemporaryDirectory(prefix="kubeast-cc-") as workdir:
                options = _options(sdk, model=model, system_prompt=system_prompt, token=token, workdir=workdir,
                                   stderr=stderr.append, partial=True)
                queue.put_nowait((done, await _run(sdk, prompt, options, on_message, stderr, lane)))
        except Exception as e:  # handed to the consumer; cancellation is not caught
            queue.put_nowait((done, e))

    task = asyncio.create_task(pump())
    sent: list[str] = []
    try:
        while True:
            kind, value = await queue.get()
            if kind is done:
                if isinstance(value, Exception):
                    raise value
                text = str(value.result or "".join(sent))
                if not sent and text:
                    yield text  # nothing came in pieces
                yield Completion(text=text, usage=usage_of(value.usage))
                return
            sent.append(value)
            yield value
    finally:
        if not task.done():
            task.cancel()  # the SDK stops the CLI when its query is cancelled


def _usage_ns(usage: Optional[dict]):
    u = dict(usage or {})
    details = SimpleNamespace(**u.pop("prompt_tokens_details", {}))
    return SimpleNamespace(**u, prompt_tokens_details=details)


class _Completions:
    """chat.completions for the provider adapter: plain completions only. A turn with tools goes through
    ClaudeCodeChat.turn (the chat, app.services.ai.tool_turn); a caller that sends tools here is refused."""

    def __init__(self, model: str, token: str):
        self._model, self._token = model, token

    async def create(self, *, messages, model: Optional[str] = None, tools=None, stream: bool = False, **_ignored):
        if tools:
            raise ClaudeCodeError("the Claude subscription provider runs tools only in the AI chat")
        if not stream:
            done = await complete(messages, model=model or self._model, token=self._token)
            message = SimpleNamespace(content=done.text, tool_calls=None, role="assistant")
            return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="stop", index=0)],
                                   usage=_usage_ns(done.usage), model=model or self._model)

        async def chunks():  # the text as it is written, then the end and the usage, as an API stream ends
            async for item in stream_complete(messages, model=model or self._model, token=self._token):
                if isinstance(item, Completion):
                    end = SimpleNamespace(content=None, tool_calls=None, role=None)
                    yield SimpleNamespace(choices=[SimpleNamespace(delta=end, finish_reason="stop", index=0)], usage=None)
                    yield SimpleNamespace(choices=[], usage=_usage_ns(item.usage))
                    return
                delta = SimpleNamespace(content=item, tool_calls=None, role="assistant")
                yield SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=None, index=0)], usage=None)
        return chunks()


@dataclass
class TurnResult:
    text: str = ""                 # the answer: the text after the last tool call, as the API-key path saves
    tool_calls: int = 0
    turns: int = 0                 # the model responses seen: a response's tool calls share its number
    finish_reason: Optional[str] = None
    usage: Optional[dict] = None


def tool_schema(parameters: Any) -> dict:
    """A chat tool's parameters as the SDK takes a JSON Schema (it needs type and properties)."""
    schema = dict(parameters) if isinstance(parameters, dict) else {}
    schema.setdefault("type", "object")
    if not isinstance(schema.get("properties"), dict):
        schema["properties"] = {}
    return schema


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


class ClaudeCodeChat:
    def __init__(self, model: str, token: str):
        self.model, self._token = model, token
        self.chat = SimpleNamespace(completions=_Completions(model, token))

    async def complete(self, messages: Sequence[dict], *, lane: str = "chat") -> Completion:
        return await complete(messages, model=self.model, token=self._token, lane=lane)

    async def turn(self, *, messages: Sequence[dict], tools: Sequence[dict], run_tool: ToolRunner,
                   out: TurnResult, model: Optional[str] = None, turn_limit: Optional[int] = None,
                   lane: str = "chat") -> AsyncIterator[str]:
        """One chat turn: yields the chat's SSE events (answer text; for each tool call a `function` event,
        then whatever run_tool returns) and fills `out`. Raises ClaudeCodeError when the run fails.
        turn_limit caps the model turns (default AI_CLAUDE_CODE_MAX_TURNS)."""
        reason = unavailable_reason()
        if reason:
            raise ClaudeCodeError(reason)
        sdk = _sdk()
        system_prompt, prompt = split_messages(messages)
        queue: asyncio.Queue = asyncio.Queue()
        done = object()
        # A response arrives as several assistant messages (text, each tool call); the next response starts
        # with the first one after a tool result. Its number is what the API-key path calls the iteration.
        state = {"turn": 0, "fresh": True}

        def handler_for(name: str):
            async def handler(args: dict) -> dict:
                out.tool_calls += 1
                args = args if isinstance(args, dict) else {}
                queue.put_nowait(("sse", _sse({"function": name, "args": args})))  # the chat shows the call at once
                events, text = await run_tool(name, args, max(1, state["turn"]))
                state["fresh"] = True
                for event in events:
                    queue.put_nowait(("sse", event))
                queue.put_nowait(("tool", None))
                return {"content": [{"type": "text", "text": text}]}
            return handler

        sdk_tools, names = [], []
        for entry in tools:
            fn = entry.get("function") or {}
            name = fn.get("name")
            if not name or name in names:
                continue
            names.append(name)
            sdk_tools.append(sdk.tool(name, fn.get("description") or "", tool_schema(fn.get("parameters")))(handler_for(name)))
        server = sdk.create_sdk_mcp_server(TOOL_SERVER, "1.0.0", sdk_tools) if sdk_tools else None
        pieces = _TextPieces(sdk)

        def on_message(message) -> None:
            if isinstance(message, sdk.AssistantMessage) and state["fresh"]:
                state["turn"], state["fresh"] = state["turn"] + 1, False
            for piece in pieces.feed(message):
                queue.put_nowait(("text", piece))

        async def pump() -> None:
            stderr: deque = deque(maxlen=STDERR_LINES)
            try:
                with tempfile.TemporaryDirectory(prefix="kubeast-cc-") as workdir:
                    options = _options(sdk, model=model or self.model, system_prompt=system_prompt, token=self._token,
                                       workdir=workdir, server=server, allowed=[TOOL_PREFIX + n for n in names],
                                       turns=turn_limit or max_turns(), stderr=stderr.append, partial=True)
                    queue.put_nowait((done, await _run(sdk, prompt, options, on_message, stderr, lane)))
            except Exception as e:  # handed to the consumer; cancellation is not caught
                queue.put_nowait((done, e))

        task = asyncio.create_task(pump())
        answer = ""
        try:
            while True:
                kind, value = await queue.get()
                if kind is done:
                    if isinstance(value, Exception):
                        raise value
                    out.usage = usage_of(value.usage)
                    out.turns = state["turn"]  # Claude Code's num_turns counts one more on a run cut at max_turns
                    if value.subtype == "error_max_turns":
                        out.finish_reason, out.text = "max_turns", ""
                    else:
                        out.finish_reason = "stop"
                        out.text = str(value.result or answer)
                    return
                if kind == "text":  # a piece carries its paragraph break; the saved answer starts without one
                    answer = answer + value if answer else value.lstrip("\n")
                    yield _sse({"content": value})
                elif kind == "tool":
                    answer = ""  # the saved answer is what comes after the last tool call
                else:
                    yield value
        finally:
            if not task.done():
                task.cancel()  # the SDK stops the CLI when its query is cancelled


async def test_connection(model: str, token: str) -> dict:
    """Admin → AI Models "Test": one tiny completion through Claude Code."""
    try:
        done = await complete([{"role": "user", "content": "Reply with exactly the word: ok"}], model=model, token=token)
    except ClaudeCodeError as e:
        return {"success": False, "message": str(e)}
    return {"success": True, "model": model, "message": f"Connection successful ({done.text.strip()[:20]})"}
