"""provider "anthropic" over the native Messages API (app/services/anthropic_messages.py).

FakeAnthropic is an httpx transport that answers like /v1/messages and refuses
what the real API refuses with a 400: system inside messages, a conversation
that does not start with or alternate from user, a tool_result that does not
answer the previous tool_use, thinking blocks of a tool turn not sent back
unchanged, and sampling parameters on Claude 4.7 and later. The real
investigation loop and the real optimization stream run against it.
"""
import json
from types import SimpleNamespace

import httpx
import pytest

from app.services import anthropic_messages as am
from app.services.ai.streaming import suggest_optimization_stream
from app.services.investigation import runner
from app.services.provider_adapter import ProviderAdapter
from tests.test_alert_investigation import FakeService, cfg, install_loop, row
from tests.test_streaming import _make_service

THINK = {"type": "thinking", "thinking": "Check the pods first.", "signature": "sig-abc"}


def sse(*events):
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)


class FakeAnthropic:
    def __init__(self, replies, status=None):
        self.replies = list(replies)
        self.status = list(status or [])
        self.bodies = []
        self.thinking_by_tool = {}

    def check(self, body):
        model = body["model"]
        if am.model_version(model) is None or am.model_version(model) >= (4, 7):
            bad = [k for k in am.SAMPLING if k in body]
            if bad:
                return f"{bad[0]} is not supported on this model"
        if "temperature" in body and "top_p" in body:
            return "temperature and top_p cannot both be specified"
        if not isinstance(body.get("max_tokens"), int):
            return "max_tokens: field required"
        msgs = body["messages"]
        if not msgs or msgs[0]["role"] != "user":
            return "first message must use the user role"
        for i, m in enumerate(msgs):
            if m["role"] not in ("user", "assistant"):
                return f"messages.{i}.role: unexpected value {m['role']}"
            if i and msgs[i - 1]["role"] == m["role"]:
                return "roles must alternate"
            results = [b for b in m["content"] if b.get("type") == "tool_result"]
            if results:
                if m["content"][: len(results)] != results:
                    return "tool_result blocks must come first"
                asked = {b["id"] for b in msgs[i - 1]["content"] if b.get("type") == "tool_use"}
                if {b["tool_use_id"] for b in results} != asked:
                    return "tool_result ids do not match the previous tool_use ids"
            if m["role"] == "assistant":
                uses = [b for b in m["content"] if b.get("type") == "tool_use"]
                want = self.thinking_by_tool.get(uses[0]["id"]) if uses else None
                if want and m["content"][: len(want)] != want:
                    return "thinking blocks of a tool turn must be passed back unmodified"
        return None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/messages"
        assert request.headers["x-api-key"] == "sk-ant-test" and request.headers["anthropic-version"] == am.API_VERSION
        body = json.loads(request.content)
        self.bodies.append(body)
        if self.status:
            code = self.status.pop(0)
            return httpx.Response(code, json={"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})
        problem = self.check(body)
        if problem:
            return httpx.Response(400, json={"type": "error", "error": {"type": "invalid_request_error", "message": problem}})
        reply = self.replies.pop(0)
        if isinstance(reply, str):
            return httpx.Response(200, text=reply, headers={"content-type": "text/event-stream"})
        blocks = reply["content"]
        uses = [b for b in blocks if b["type"] == "tool_use"]
        thinks = [b for b in blocks if b["type"] in ("thinking", "redacted_thinking")]
        if uses and thinks:
            self.thinking_by_tool[uses[0]["id"]] = thinks
        return httpx.Response(200, json={"id": "msg_1", "type": "message", "role": "assistant", "model": body["model"], **reply})


def client_for(fake, model="claude-opus-5-5", **kw):
    http = httpx.AsyncClient(transport=httpx.MockTransport(fake))
    return am.AnthropicMessagesClient(model=model, api_key="sk-ant-test", http_client=http, **kw)


# --- request translation ---


def test_versions_and_sampling_rule():
    assert am.model_version("claude-opus-4-1-20250805") == (4, 1)
    assert am.model_version("claude-3-5-haiku-20241022") == (3, 5)
    assert am.model_version("claude-sonnet-4-20250514") == (4, 0)
    assert am.model_version("claude-opus-5-5") == (5, 5)
    assert am.model_version("claude-mythos-preview") is None
    assert [am.takes_sampling(m) for m in ("claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-5-5", "claude-mythos-preview")] == [
        True, False, False, False,
    ]


def test_models_that_think_by_default_get_room_for_the_thinking():
    assert [am.thinks_by_default(m) for m in ("claude-haiku-5-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-mythos-preview")] == [
        True, False, False, True,
    ]
    c = client_for(FakeAnthropic([]))
    msgs = [{"role": "user", "content": "hi"}]
    assert c.build_request(dict(model="claude-haiku-5-5", messages=msgs, max_tokens=1800))["max_tokens"] == 1800 + am.THINKING_HEADROOM
    assert c.build_request(dict(model="claude-opus-4-8", messages=msgs, max_tokens=1800))["max_tokens"] == 1800


def test_base_url_from_the_compatible_endpoint_goes_to_the_root():
    assert am.api_root("https://api.anthropic.com/v1/") == "https://api.anthropic.com"
    assert am.api_root("https://gateway.internal/anthropic") == "https://gateway.internal/anthropic"
    assert am.api_root(None) == am.DEFAULT_BASE_URL


def test_request_hoists_system_merges_tool_results_and_maps_tools():
    c = client_for(FakeAnthropic([]))
    body = c.build_request(dict(
        model="claude-opus-5-5",
        messages=[
            {"role": "system", "content": "You are Kubeast."},
            {"role": "user", "content": "why is pod-1 failing?"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "t1", "type": "function", "function": {"name": "k8s_get_resources", "arguments": '{"resource_type": "pods"}'}},
                {"id": "t2", "type": "function", "function": {"name": "k8s_get_pod_logs", "arguments": "not json"}},
            ]},
            {"role": "tool", "tool_call_id": "t1", "content": "pod-1 0/1"},
            {"role": "tool", "tool_call_id": "t2", "content": ""},
            {"role": "system", "content": "Answer in Korean."},
        ],
        tools=[{"type": "function", "function": {"name": "k8s_get_resources", "description": "list", "parameters": {"type": "object"}}}],
        tool_choice="auto", temperature=0.7, top_p=0.9, max_tokens=900, stop=["\n\nHuman:", "  "], stream=True,
        stream_options={"include_usage": True}, timeout=60.0,
    ))
    assert body["system"] == "You are Kubeast.\nAnswer in Korean."
    assert [m["role"] for m in body["messages"]] == ["user", "assistant", "user"]
    assert body["messages"][1]["content"] == [
        {"type": "tool_use", "id": "t1", "name": "k8s_get_resources", "input": {"resource_type": "pods"}},
        {"type": "tool_use", "id": "t2", "name": "k8s_get_pod_logs", "input": {}},
    ]
    assert body["messages"][2]["content"] == [
        {"type": "tool_result", "tool_use_id": "t1", "content": "pod-1 0/1"},
        {"type": "tool_result", "tool_use_id": "t2"},
    ]
    assert body["tools"] == [{"name": "k8s_get_resources", "description": "list", "input_schema": {"type": "object"}}]
    assert body["tool_choice"] == {"type": "auto"} and body["max_tokens"] == 900 + am.THINKING_HEADROOM and body["stream"] is True
    assert body["stop_sequences"] == ["\n\nHuman:"] and body["cache_control"] == {"type": "ephemeral"}
    assert not set(am.SAMPLING) & set(body) and "stream_options" not in body and "timeout" not in body


def test_older_models_keep_temperature_and_drop_top_p_with_it():
    body = client_for(FakeAnthropic([]), model="claude-3-5-haiku-20241022").build_request(
        dict(messages=[{"role": "user", "content": "hi"}], temperature=0.2, top_p=0.9))
    assert body["temperature"] == 0.2 and "top_p" not in body and body["max_tokens"] == am.DEFAULT_MAX_TOKENS  # no thinking by default


def test_tool_choice_and_options():
    c = client_for(FakeAnthropic([]), options={"prompt_cache": False, "num_ctx": 8192, "max_tokens": 2000})
    tools = [{"type": "function", "function": {"name": "x"}}]
    base = dict(messages=[{"role": "user", "content": "hi"}], tools=tools)
    assert c.build_request({**base, "tool_choice": "required"})["tool_choice"] == {"type": "any"}
    assert c.build_request({**base, "tool_choice": {"type": "function", "function": {"name": "x"}}})["tool_choice"] == {"type": "tool", "name": "x"}
    assert c.build_request({**base, "parallel_tool_calls": False})["tool_choice"] == {"type": "auto", "disable_parallel_tool_use": True}
    body = c.build_request(dict(messages=[{"role": "user", "content": "hi"}], tool_choice="auto"))
    assert "tool_choice" not in body and "cache_control" not in body and body["max_tokens"] == 2000 + am.THINKING_HEADROOM and "num_ctx" not in body


def test_provider_adapter_sends_anthropic_to_the_messages_client():
    adapter = ProviderAdapter(provider="anthropic", model="claude-opus-5-5", api_key="k", base_url="https://api.anthropic.com/v1/")
    assert isinstance(adapter.chat.completions, am._Completions)
    assert adapter.chat.completions._client.url == "https://api.anthropic.com/v1/messages"


# --- answers ---


@pytest.mark.asyncio
async def test_completion_with_thinking_and_tools_then_the_thinking_goes_back():
    fake = FakeAnthropic([
        {"content": [THINK, {"type": "text", "text": "Looking."},
                     {"type": "tool_use", "id": "toolu_1", "name": "k8s_get_resources", "input": {"resource_type": "pods"}}],
         "stop_reason": "tool_use", "usage": {"input_tokens": 50, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 100, "output_tokens": 40}},
        {"content": [{"type": "text", "text": "pod-1 is crash looping."}], "stop_reason": "end_turn", "usage": {"input_tokens": 10, "output_tokens": 5}},
    ])
    c = client_for(fake)
    first = await c.chat.completions.create(model="claude-opus-5-5", messages=[{"role": "user", "content": "why?"}], temperature=0.2)
    msg = first.choices[0].message
    assert first.choices[0].finish_reason == "tool_calls" and msg.content == "Looking."
    assert [(t.id, t.function.name, json.loads(t.function.arguments)) for t in msg.tool_calls] == [("toolu_1", "k8s_get_resources", {"resource_type": "pods"})]
    u = first.usage
    assert (u.prompt_tokens, u.completion_tokens, u.total_tokens, u.prompt_tokens_details.cached_tokens, u.cache_creation_input_tokens) == (1050, 40, 1090, 900, 100)

    history = [
        {"role": "user", "content": "why?"},
        {"role": "assistant", "content": msg.content, "tool_calls": [
            {"id": t.id, "type": "function", "function": {"name": t.function.name, "arguments": t.function.arguments}} for t in msg.tool_calls]},
        {"role": "tool", "tool_call_id": "toolu_1", "content": "pod-1 0/1 CrashLoopBackOff"},
    ]
    second = await c.chat.completions.create(model="claude-opus-5-5", messages=history)
    assert second.choices[0].message.content == "pod-1 is crash looping." and second.choices[0].message.tool_calls is None
    assert fake.bodies[1]["messages"][1]["content"][0] == THINK  # put back first, unchanged


@pytest.mark.asyncio
async def test_without_the_kept_thinking_the_api_refuses():
    fake = FakeAnthropic([{"content": [THINK, {"type": "tool_use", "id": "toolu_9", "name": "x", "input": {}}], "stop_reason": "tool_use", "usage": {}}])
    await client_for(fake).chat.completions.create(messages=[{"role": "user", "content": "go"}])
    other = client_for(fake)  # a client that never saw the first answer
    with pytest.raises(am.AnthropicAPIError) as e:
        await other.chat.completions.create(messages=[
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "toolu_9", "type": "function", "function": {"name": "x", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "toolu_9", "content": "ok"},
        ])
    assert e.value.status_code == 400 and "thinking" in e.value.message


@pytest.mark.asyncio
async def test_overloaded_is_retried_and_a_400_is_not(monkeypatch):
    async def no_sleep(_):
        return None

    monkeypatch.setattr(am.asyncio, "sleep", no_sleep)
    fake = FakeAnthropic([{"content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn", "usage": {}}], status=[529, 529])
    out = await client_for(fake).chat.completions.create(messages=[{"role": "user", "content": "hi"}])
    assert out.choices[0].message.content == "ok" and len(fake.bodies) == 3

    with pytest.raises(am.AnthropicAPIError) as e:
        await client_for(FakeAnthropic([])).chat.completions.create(messages=[{"role": "assistant", "content": "hi"}])
    assert e.value.status_code == 400 and e.value.error_type == "invalid_request_error"


# --- streams ---

STREAM_TOOLS = sse(
    {"type": "message_start", "message": {"id": "msg_s", "model": "claude-opus-5-5", "content": [],
                                          "usage": {"input_tokens": 20, "cache_read_input_tokens": 300, "output_tokens": 1}}},
    {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
    {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Check the pods first."}},
    {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig-abc"}},
    {"type": "content_block_stop", "index": 0},
    {"type": "ping"},
    {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
    {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Let me "}},
    {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "look."}},
    {"type": "content_block_stop", "index": 1},
    {"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "toolu_a", "name": "k8s_get_resources", "input": {}}},
    {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": ""}},
    {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": '{"resource_type":'}},
    {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": ' "pods"}'}},
    {"type": "content_block_stop", "index": 2},
    {"type": "content_block_start", "index": 3, "content_block": {"type": "tool_use", "id": "toolu_b", "name": "k8s_get_pod_logs", "input": {}}},
    {"type": "content_block_delta", "index": 3, "delta": {"type": "input_json_delta", "partial_json": '{"pod_name": "p"}'}},
    {"type": "content_block_stop", "index": 3},
    {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 60}},
    {"type": "message_stop"},
)


async def consume_like_the_chat_loop(stream):
    """The accumulation app/services/ai/streaming.py does for a chat turn."""
    text, calls, usage, finish = "", {}, None, None
    async for chunk in stream:
        if getattr(chunk, "usage", None) is not None:
            usage = chunk.usage
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        finish = chunk.choices[0].finish_reason or finish
        if delta.content:
            text += delta.content
        for tc in delta.tool_calls or []:
            entry = calls.setdefault(tc.index, {"id": tc.id or "", "name": getattr(tc.function, "name", "") or "", "arguments": ""})
            if tc.id:
                entry["id"] = tc.id
            if getattr(tc.function, "name", None):
                entry["name"] = tc.function.name
            if getattr(tc.function, "arguments", None):
                entry["arguments"] += tc.function.arguments
    return text, calls, usage, finish


@pytest.mark.asyncio
async def test_stream_turns_events_into_openai_chunks_and_keeps_thinking():
    fake = FakeAnthropic([STREAM_TOOLS, sse(
        {"type": "message_start", "message": {"id": "m2", "model": "claude-opus-5-5", "usage": {"input_tokens": 5}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Done."}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "max_tokens"}, "usage": {"output_tokens": 3}},
        {"type": "message_stop"},
    )])
    fake.thinking_by_tool["toolu_a"] = [THINK]  # what the real API would demand back
    c = client_for(fake)
    text, calls, usage, finish = await consume_like_the_chat_loop(
        await c.chat.completions.create(messages=[{"role": "user", "content": "why?"}], stream=True, temperature=0.7))
    assert text == "Let me look." and finish == "tool_calls"
    assert calls == {0: {"id": "toolu_a", "name": "k8s_get_resources", "arguments": '{"resource_type": "pods"}'},
                     1: {"id": "toolu_b", "name": "k8s_get_pod_logs", "arguments": '{"pod_name": "p"}'}}
    assert (usage.prompt_tokens, usage.completion_tokens, usage.prompt_tokens_details.cached_tokens) == (320, 60, 300)

    history = [{"role": "user", "content": "why?"},
               {"role": "assistant", "content": text, "tool_calls": [
                   {"id": v["id"], "type": "function", "function": {"name": v["name"], "arguments": v["arguments"]}} for v in calls.values()]},
               {"role": "tool", "tool_call_id": "toolu_a", "content": "pods"},
               {"role": "tool", "tool_call_id": "toolu_b", "content": "logs"}]
    text2, _, _, finish2 = await consume_like_the_chat_loop(await c.chat.completions.create(messages=history, stream=True))
    assert text2 == "Done." and finish2 == "length"  # the chat loop continues on "length"
    assert fake.bodies[1]["messages"][1]["content"][0] == THINK


@pytest.mark.asyncio
async def test_an_error_event_mid_stream_raises():
    fake = FakeAnthropic([sse(
        {"type": "message_start", "message": {"id": "m", "usage": {"input_tokens": 1}}},
        {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}},
    )])
    stream = await client_for(fake).chat.completions.create(messages=[{"role": "user", "content": "x"}], stream=True)
    with pytest.raises(am.AnthropicAPIError) as e:
        await consume_like_the_chat_loop(stream)
    assert e.value.error_type == "overloaded_error"


# --- the real callers ---


@pytest.mark.asyncio
async def test_the_investigation_loop_runs_on_the_messages_api(monkeypatch):
    fake = FakeAnthropic([
        {"content": [THINK, {"type": "tool_use", "id": "toolu_i", "name": "k8s_get_resources", "input": {"resource_type": "pods", "namespace": "apps"}}],
         "stop_reason": "tool_use", "usage": {"input_tokens": 100, "output_tokens": 20}},
        {"content": [{"type": "text", "text": "## Summary\nCrash looping."}], "stop_reason": "end_turn", "usage": {"input_tokens": 30, "output_tokens": 10}},
    ])
    service = FakeService([])
    service.provider, service.model = "anthropic", "claude-opus-5-5"
    service.client = client_for(fake)
    install_loop(monkeypatch, service, [])
    out = await runner.investigate(cfg(max_steps=4), row())
    assert out["report"] == "## Summary\nCrash looping." and out["total_tokens"] == 160
    assert service.executed == [("k8s_get_resources", {"resource_type": "pods", "namespace": "apps"})]
    first, second = fake.bodies
    assert "temperature" not in first and first["system"].startswith("You are Kubeast's alert investigator")
    assert second["messages"][1]["content"][0] == THINK  # the runner kept text and tool calls only


@pytest.mark.asyncio
async def test_the_optimization_stream_runs_on_the_messages_api():
    fake = FakeAnthropic([sse(
        {"type": "message_start", "message": {"id": "m", "model": "claude-sonnet-5-5", "usage": {"input_tokens": 40}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Lower "}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "the requests."}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 7}},
        {"type": "message_stop"},
    )])
    service = _make_service()
    service.model = "claude-sonnet-5-5"
    service.client = client_for(fake, model="claude-sonnet-5-5")
    events = [e async for e in suggest_optimization_stream(service, "default", lang="en")]
    parsed = [json.loads(e[len("data: "):]) for e in events if e.startswith("data: {")]
    assert "".join(p["content"] for p in parsed if p.get("kind") == "answer") == "Lower the requests."
    assert [p for p in parsed if p.get("kind") == "usage"][0]["usage"]["total_tokens"] == 47
    assert [p for p in parsed if p.get("kind") == "meta"][0]["finish_reason"] == "stop"
    assert len(fake.bodies) == 1 and "temperature" not in fake.bodies[0]  # no 400, no fallback retry
