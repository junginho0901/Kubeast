"""provider "anthropic" over the native Messages API (POST /v1/messages),
behind the chat.completions.create(...) interface every caller already uses.

Anthropic's OpenAI-compatible endpoint is meant for testing: it has no prompt
caching and returns no thinking, and Claude 4.7 and later reject the sampling
parameters the callers send. This client turns an OpenAI-style request into a
Messages request and the answer or the event stream back into OpenAI-shaped
objects, so the callers do not change.

Thinking: Claude 5 models think by default, and when tool results go back the
thinking blocks of that assistant turn must go back unmodified. The callers
keep only text and tool calls, so the blocks are kept here by the turn's first
tool_use id (globally unique, so a client shared by requests does not mix
them) and put back in front of that assistant message.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections import OrderedDict
from types import SimpleNamespace as NS
from typing import Any, AsyncIterator, Optional

import httpx

log = logging.getLogger(__name__)

API_VERSION = "2023-06-01"
DEFAULT_BASE_URL = "https://api.anthropic.com"
DEFAULT_MAX_TOKENS = 4096
DEFAULT_TIMEOUT = 600.0
RETRY_STATUS = frozenset({429, 500, 502, 503, 504, 529})
MAX_RETRIES = 2
MAX_RETRY_WAIT = 20.0
THINKING_KEEP = 512
# Thinking tokens count toward max_tokens; a caller's limit is sized for the answer.
THINKING_HEADROOM = 4096

STOP_REASONS = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "tool_use": "tool_calls",
    "refusal": "content_filter",
}
SAMPLING = ("temperature", "top_p", "top_k")
# claude-opus-4-1-20250805 → (4, 1), claude-3-5-haiku-20241022 → (3, 5), claude-sonnet-4-20250514 → (4, 0)
_VERSION = re.compile(r"claude-(?:[a-z]+-)?(\d{1,2})(?:-(\d{1,2})(?!\d))?")


class AnthropicAPIError(Exception):
    def __init__(self, status_code: Optional[int], error_type: str, message: str):
        self.status_code = status_code
        self.error_type = error_type
        self.message = message
        super().__init__(f"Anthropic API error {status_code or '-'} {error_type}: {message}")

    @classmethod
    def from_body(cls, status_code: Optional[int], body: bytes | str) -> "AnthropicAPIError":
        text = body.decode("utf-8", "replace") if isinstance(body, bytes) else body
        try:
            err = json.loads(text).get("error") or {}
            return cls(status_code, err.get("type") or "error", err.get("message") or text[:300])
        except (ValueError, AttributeError):
            return cls(status_code, "error", text[:300])


def model_version(model: str) -> Optional[tuple[int, int]]:
    m = _VERSION.search((model or "").lower())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2) or 0)


def takes_sampling(model: str) -> bool:
    """Claude 4.7 and later (and names without a version, such as Mythos
    Preview) reject temperature, top_p and top_k."""
    v = model_version(model)
    return v is not None and v < (4, 7)


def thinks_by_default(model: str) -> bool:
    """Claude 5 models (and names without a version, such as Mythos Preview)
    think when the request has no thinking field."""
    v = model_version(model)
    return v is None or v >= (5, 0)


def api_root(base_url: Optional[str]) -> str:
    """The configured base URL may be the OpenAI-compatible one (…/v1/)."""
    root = (base_url or "").strip().rstrip("/") or DEFAULT_BASE_URL
    return root[: -len("/v1")] if root.endswith("/v1") else root


def _text_of(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return str(content)


def _usage(u: dict) -> NS:
    read = int(u.get("cache_read_input_tokens") or 0)
    written = int(u.get("cache_creation_input_tokens") or 0)
    prompt = int(u.get("input_tokens") or 0) + read + written
    completion = int(u.get("output_tokens") or 0)
    return NS(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=prompt + completion,
        prompt_tokens_details=NS(cached_tokens=read),
        cache_creation_input_tokens=written,
    )


def _chunk(msg_id: str, model: str, *, content: Optional[str] = None, tool_calls: Optional[list] = None,
           finish_reason: Optional[str] = None) -> NS:
    delta = NS(role=None, content=content, tool_calls=tool_calls)
    return NS(id=msg_id, object="chat.completion.chunk", model=model, usage=None,
              choices=[NS(index=0, delta=delta, finish_reason=finish_reason)])


class _Completions:
    def __init__(self, client: "AnthropicMessagesClient"):
        self._client = client

    async def create(self, **kwargs: Any):
        return await self._client.create(**kwargs)


class AnthropicMessagesClient:
    def __init__(
        self,
        *,
        model: str,
        api_key: str,
        base_url: Optional[str] = None,
        http_client: Optional[httpx.AsyncClient] = None,
        default_headers: Optional[dict[str, str]] = None,
        options: Optional[dict[str, Any]] = None,
    ):
        self.model = model
        self.url = api_root(base_url) + "/v1/messages"
        self._http = http_client or httpx.AsyncClient()
        self._headers = {
            "x-api-key": api_key or "",
            "anthropic-version": API_VERSION,
            "content-type": "application/json",
            **(default_headers or {}),
        }
        opts = dict(options or {})
        self._prompt_cache = opts.pop("prompt_cache", True) is not False
        self._options = {k: v for k, v in opts.items() if k in (*SAMPLING, "max_tokens", "stop")}
        ignored = sorted(set(opts) - set(self._options))
        if ignored:
            log.info("anthropic: model options not used by the Messages API: %s", ignored)
        self._thinking: "OrderedDict[str, list[dict]]" = OrderedDict()
        self.chat = NS(completions=_Completions(self))

    # --- thinking kept between the calls of one tool loop ---

    def _remember(self, tool_use_id: Optional[str], blocks: list[dict]) -> None:
        if not tool_use_id or not blocks:
            return
        self._thinking[tool_use_id] = blocks
        self._thinking.move_to_end(tool_use_id)
        while len(self._thinking) > THINKING_KEEP:
            self._thinking.popitem(last=False)

    def _recall(self, tool_use_id: Optional[str]) -> list[dict]:
        return list(self._thinking.get(tool_use_id or "", []))

    # --- request ---

    def build_request(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        model = kwargs.get("model") or self.model
        system: list[str] = []
        messages: list[dict[str, Any]] = []

        def add(role: str, blocks: list[dict]) -> None:
            if not blocks:
                return
            if messages and messages[-1]["role"] == role:
                messages[-1]["content"].extend(blocks)
            else:
                messages.append({"role": role, "content": blocks})

        for m in kwargs.get("messages") or []:
            role = m.get("role")
            if role in ("system", "developer"):
                text = _text_of(m.get("content"))
                if text:
                    system.append(text)
            elif role == "user":
                text = _text_of(m.get("content"))
                add("user", [{"type": "text", "text": text}] if text else [])
            elif role == "assistant":
                calls = m.get("tool_calls") or []
                blocks = self._recall(calls[0].get("id")) if calls else []
                text = _text_of(m.get("content"))
                if text:
                    blocks.append({"type": "text", "text": text})
                for c in calls:
                    fn = c.get("function") or {}
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except (TypeError, ValueError):
                        args = {}
                    blocks.append({"type": "tool_use", "id": c.get("id") or "", "name": fn.get("name") or "",
                                   "input": args if isinstance(args, dict) else {}})
                add("assistant", blocks)
            elif role == "tool":
                block: dict[str, Any] = {"type": "tool_result", "tool_use_id": m.get("tool_call_id") or ""}
                text = _text_of(m.get("content"))
                if text:
                    block["content"] = text
                add("user", [block])

        max_tokens = int(kwargs.get("max_tokens") or kwargs.get("max_completion_tokens")
                         or self._options.get("max_tokens") or DEFAULT_MAX_TOKENS)
        if thinks_by_default(model):
            max_tokens += THINKING_HEADROOM
        body: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "messages": messages}
        if system:
            body["system"] = "\n".join(system)

        tools = [t.get("function") or {} for t in kwargs.get("tools") or [] if t.get("type", "function") == "function"]
        if tools:
            body["tools"] = [
                {"name": f.get("name") or "", "description": f.get("description") or "",
                 "input_schema": f.get("parameters") or {"type": "object", "properties": {}}}
                for f in tools
            ]
            choice = self._tool_choice(kwargs.get("tool_choice"))
            if kwargs.get("parallel_tool_calls") is False:
                choice = {**(choice or {"type": "auto"}), "disable_parallel_tool_use": True}
            if choice:
                body["tool_choice"] = choice

        sampling = {k: kwargs[k] for k in SAMPLING if kwargs.get(k) is not None}
        for k in SAMPLING:
            if k in self._options:
                sampling.setdefault(k, self._options[k])
        if sampling and takes_sampling(model):
            if "temperature" in sampling:
                sampling.pop("top_p", None)
            body.update(sampling)

        stop = kwargs.get("stop", self._options.get("stop"))
        if stop:
            seqs = [s for s in ([stop] if isinstance(stop, str) else list(stop)) if s and s.strip()]
            if seqs:
                body["stop_sequences"] = seqs

        if self._prompt_cache:
            body["cache_control"] = {"type": "ephemeral"}
        if kwargs.get("stream"):
            body["stream"] = True
        return body

    @staticmethod
    def _tool_choice(choice: Any) -> Optional[dict[str, Any]]:
        if choice is None:
            return None
        if choice == "auto":
            return {"type": "auto"}
        if choice == "none":
            return {"type": "none"}
        if choice == "required":
            return {"type": "any"}
        if isinstance(choice, dict):
            name = (choice.get("function") or {}).get("name")
            if name:
                return {"type": "tool", "name": name}
        return None

    # --- transport ---

    async def _send(self, body: dict[str, Any], timeout: float, stream: bool) -> httpx.Response:
        for attempt in range(MAX_RETRIES + 1):
            request = self._http.build_request("POST", self.url, json=body, headers=self._headers,
                                               timeout=httpx.Timeout(timeout))
            try:
                resp = await self._http.send(request, stream=stream)
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.RemoteProtocolError) as e:
                if attempt < MAX_RETRIES:
                    await asyncio.sleep(0.5 * (attempt + 1))
                    continue
                raise AnthropicAPIError(None, "connection_error", type(e).__name__) from e
            if resp.status_code < 400:
                return resp
            raw = await resp.aread()
            await resp.aclose()
            if resp.status_code in RETRY_STATUS and attempt < MAX_RETRIES:
                await asyncio.sleep(self._retry_wait(resp, attempt))
                continue
            raise AnthropicAPIError.from_body(resp.status_code, raw)
        raise AnthropicAPIError(None, "error", "retries exhausted")  # not reached

    @staticmethod
    def _retry_wait(resp: httpx.Response, attempt: int) -> float:
        try:
            return min(float(resp.headers.get("retry-after", "")), MAX_RETRY_WAIT)
        except ValueError:
            return 0.5 * (attempt + 1)

    async def create(self, **kwargs: Any):
        body = self.build_request(kwargs)
        timeout = float(kwargs.get("timeout") or DEFAULT_TIMEOUT)
        if body.get("stream"):
            resp = await self._send(body, timeout, stream=True)
            return self._stream(resp, body["model"])
        resp = await self._send(body, timeout, stream=False)
        return self._completion(resp.json(), body["model"])

    # --- answers ---

    def _completion(self, data: dict[str, Any], model: str) -> NS:
        content = data.get("content") or []
        text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
        calls = [
            NS(id=b.get("id"), type="function",
               function=NS(name=b.get("name"), arguments=json.dumps(b.get("input") or {}, ensure_ascii=False)))
            for b in content if b.get("type") == "tool_use"
        ]
        if calls:
            self._remember(calls[0].id, [b for b in content if b.get("type") in ("thinking", "redacted_thinking")])
        message = NS(role="assistant", content=text, tool_calls=calls or None)
        return NS(
            id=data.get("id"), object="chat.completion", model=data.get("model") or model, created=int(time.time()),
            choices=[NS(index=0, message=message, finish_reason=STOP_REASONS.get(data.get("stop_reason") or "", "stop"))],
            usage=_usage(data.get("usage") or {}),
        )

    async def _events(self, resp: httpx.Response) -> AsyncIterator[dict[str, Any]]:
        data: list[str] = []
        async for line in resp.aiter_lines():
            if line.startswith("data:"):
                data.append(line[5:].strip())
            elif not line.strip() and data:
                yield json.loads("\n".join(data))
                data = []
        if data:
            yield json.loads("\n".join(data))

    async def _stream(self, resp: httpx.Response, model: str) -> AsyncIterator[NS]:
        msg_id, usage = "", {}
        blocks: dict[int, dict[str, Any]] = {}
        thinking: list[dict[str, Any]] = []
        tools = 0
        first_tool: Optional[str] = None
        stop_reason = None
        try:
            async for ev in self._events(resp):
                kind = ev.get("type")
                if kind == "message_start":
                    message = ev.get("message") or {}
                    msg_id, model = message.get("id") or "", message.get("model") or model
                    usage.update(message.get("usage") or {})
                elif kind == "content_block_start":
                    cb = ev.get("content_block") or {}
                    idx = ev.get("index", 0)
                    if cb.get("type") == "tool_use":
                        blocks[idx] = {"type": "tool_use", "tool_index": tools}
                        first_tool = first_tool or cb.get("id")
                        yield _chunk(msg_id, model, tool_calls=[NS(index=tools, id=cb.get("id"), type="function",
                                                                   function=NS(name=cb.get("name"), arguments=""))])
                        tools += 1
                    elif cb.get("type") == "thinking":
                        blocks[idx] = {"type": "thinking", "thinking": cb.get("thinking") or "", "signature": cb.get("signature") or ""}
                    elif cb.get("type") == "redacted_thinking":
                        blocks[idx] = dict(cb)
                    else:
                        blocks[idx] = {"type": cb.get("type")}
                        if cb.get("type") == "text" and cb.get("text"):
                            yield _chunk(msg_id, model, content=cb["text"])
                elif kind == "content_block_delta":
                    d = ev.get("delta") or {}
                    block = blocks.get(ev.get("index", 0)) or {}
                    dt = d.get("type")
                    if dt == "text_delta" and d.get("text"):
                        yield _chunk(msg_id, model, content=d["text"])
                    elif dt == "input_json_delta" and d.get("partial_json") and block.get("type") == "tool_use":
                        yield _chunk(msg_id, model, tool_calls=[NS(index=block["tool_index"], id=None, type=None,
                                                                   function=NS(name=None, arguments=d["partial_json"]))])
                    elif dt == "thinking_delta" and block.get("type") == "thinking":
                        block["thinking"] += d.get("thinking") or ""
                    elif dt == "signature_delta" and block.get("type") == "thinking":
                        block["signature"] = d.get("signature") or ""
                elif kind == "content_block_stop":
                    block = blocks.get(ev.get("index", 0)) or {}
                    if block.get("type") in ("thinking", "redacted_thinking"):
                        thinking.append(block)
                elif kind == "message_delta":
                    stop_reason = (ev.get("delta") or {}).get("stop_reason") or stop_reason
                    usage.update(ev.get("usage") or {})  # cumulative
                elif kind == "error":
                    err = ev.get("error") or {}
                    raise AnthropicAPIError(None, err.get("type") or "error", err.get("message") or "stream error")
                elif kind == "message_stop":
                    break
        finally:
            await resp.aclose()
        self._remember(first_tool, thinking)
        yield _chunk(msg_id, model, finish_reason=STOP_REASONS.get(stop_reason or "", "stop"))
        yield NS(id=msg_id, object="chat.completion.chunk", model=model, choices=[], usage=_usage(usage))
