"""provider "anthropic" over the native Messages API (app/services/anthropic_messages.py).

FakeAnthropic is an httpx transport that answers like /v1/messages and refuses
what the real API refuses with a 400: system inside messages, a conversation
that does not start with or alternate from user, a tool_result that does not
answer the previous tool_use, thinking blocks of a tool turn not sent back
unchanged with tools, a thinking block after another system text, set of tools
or message than those it was made after, and sampling parameters on Claude 4.7
and later. The real investigation loop, the real chat and the real optimization
stream run against it.
"""
import json
from types import SimpleNamespace

import httpx
import pytest

from app.services import anthropic_messages as am
from app.services.ai import tool_turn
from app.services.ai.model_requests import CountedCompletions
from app.services.ai.streaming import suggest_optimization_stream
from app.services.investigation import runner
from app.services.provider_adapter import ProviderAdapter
from tests.test_alert_investigation import FakeService, cfg, install_loop, row
from tests.test_streaming import _make_service
from tests.test_tool_results_json import TOOL, chat_turn, chunk

TOOL_2 = {"type": "function", "function": {"name": "k8s_get_events", "parameters": {"type": "object", "properties": {}}}}
THINK = {"type": "thinking", "thinking": "Check the pods first.", "signature": "sig-abc"}


def sse(*events):
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)


def sse_of(reply):
    """A whole answer as the event stream of it."""
    events = [{"type": "message_start", "message": {"id": "msg_1", "usage": {"input_tokens": 1}}}]
    for i, b in enumerate(reply["content"]):
        start, deltas = {**b}, []
        if b["type"] == "thinking":
            start = {"type": "thinking", "thinking": "", "signature": ""}
            deltas = [{"type": "thinking_delta", "thinking": b["thinking"]}, {"type": "signature_delta", "signature": b["signature"]}]
        elif b["type"] == "text":
            start, deltas = {"type": "text", "text": ""}, [{"type": "text_delta", "text": b["text"]}]
        elif b["type"] == "tool_use":
            start, deltas = {**b, "input": {}}, [{"type": "input_json_delta", "partial_json": json.dumps(b["input"])}]
        events += [{"type": "content_block_start", "index": i, "content_block": start},
                   *({"type": "content_block_delta", "index": i, "delta": d} for d in deltas),
                   {"type": "content_block_stop", "index": i}]
    events += [{"type": "message_delta", "delta": {"stop_reason": reply["stop_reason"]}, "usage": {"output_tokens": 1}},
               {"type": "message_stop"}]
    return sse(*events)


class FakeAnthropic:
    def __init__(self, replies, status=None):
        self.replies = list(replies)
        self.status = list(status or [])
        self.bodies = []
        self.thinking_by_tool = {}
        self.made = {}  # a thinking block's signature → what was in front of it when this answered with it

    @staticmethod
    def in_front(body, messages, content):
        return {"system": body.get("system"), "tools": {t["name"]: t for t in body.get("tools") or []},
                "messages": messages, "content": content}

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
                want = self.thinking_by_tool.get(uses[0]["id"]) if uses and body.get("tools") else None
                if want and m["content"][: len(want)] != want:
                    return "thinking blocks of a tool turn must be passed back unmodified"
                for j, b in enumerate(m["content"]):
                    made = self.made.get(b.get("signature") or b.get("data"))
                    if made and made != self.in_front(body, msgs[:i], m["content"][:j]):
                        return (f"messages.{i}.content.{j}: Invalid `signature` in `thinking` block. "
                                "The block is bound to a different conversation.")
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
        for j, b in enumerate(blocks):
            if b in thinks:
                self.made[b.get("signature") or b["data"]] = self.in_front(body, body["messages"], blocks[:j])
        if body.get("stream"):
            return httpx.Response(200, text=sse_of(reply), headers={"content-type": "text/event-stream"})
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
    # counted as every model call (kubeast_ai_model_requests_total), then the Messages client's own completions
    assert isinstance(adapter.chat.completions, CountedCompletions)
    assert isinstance(adapter.chat.completions._inner, am._Completions)
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
    first = await c.chat.completions.create(model="claude-opus-5-5", messages=[{"role": "user", "content": "why?"}], tools=[TOOL], temperature=0.2)
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
    second = await c.chat.completions.create(model="claude-opus-5-5", messages=history, tools=[TOOL])
    assert second.choices[0].message.content == "pod-1 is crash looping." and second.choices[0].message.tool_calls is None
    assert fake.bodies[1]["messages"][1]["content"][0] == THINK  # put back first, unchanged


@pytest.mark.asyncio
async def test_without_the_kept_thinking_the_api_refuses():
    fake = FakeAnthropic([{"content": [THINK, {"type": "tool_use", "id": "toolu_9", "name": "x", "input": {}}], "stop_reason": "tool_use", "usage": {}}])
    await client_for(fake).chat.completions.create(messages=[{"role": "user", "content": "go"}], tools=[TOOL])
    other = client_for(fake)  # a client that never saw the first answer
    with pytest.raises(am.AnthropicAPIError) as e:
        await other.chat.completions.create(tools=[TOOL], messages=[
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
        await c.chat.completions.create(messages=[{"role": "user", "content": "why?"}], tools=[TOOL], stream=True, temperature=0.7))
    assert text == "Let me look." and finish == "tool_calls"
    assert calls == {0: {"id": "toolu_a", "name": "k8s_get_resources", "arguments": '{"resource_type": "pods"}'},
                     1: {"id": "toolu_b", "name": "k8s_get_pod_logs", "arguments": '{"pod_name": "p"}'}}
    assert (usage.prompt_tokens, usage.completion_tokens, usage.prompt_tokens_details.cached_tokens) == (320, 60, 300)

    history = [{"role": "user", "content": "why?"},
               {"role": "assistant", "content": text, "tool_calls": [
                   {"id": v["id"], "type": "function", "function": {"name": v["name"], "arguments": v["arguments"]}} for v in calls.values()]},
               {"role": "tool", "tool_call_id": "toolu_a", "content": "pods"},
               {"role": "tool", "tool_call_id": "toolu_b", "content": "logs"}]
    text2, _, _, finish2 = await consume_like_the_chat_loop(await c.chat.completions.create(messages=history, tools=[TOOL], stream=True))
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


# --- thinking and the tools it is bound to ---


def log_call(call_id, pod):
    return {"type": "tool_use", "id": call_id, "name": "k8s_get_pod_logs", "input": {"pod_name": pod}}


def result_of(call_id):
    return {"type": "tool_result", "tool_use_id": call_id, "content": f"log of {call_id}"}


def said(text, stop_reason="end_turn"):
    return {"content": [{"type": "text", "text": text}], "stop_reason": stop_reason, "usage": {}}


FIRST = {"content": [THINK, {"type": "redacted_thinking", "data": "enc-1"}, {"type": "text", "text": "Looking. "},
                     log_call("toolu_1", "pod-1"), log_call("toolu_2", "pod-2")], "stop_reason": "tool_use", "usage": {}}
SECOND = {"content": [{"type": "thinking", "thinking": "", "signature": "sig-def"}, log_call("toolu_3", "pod-3")],
          "stop_reason": "tool_use", "usage": {}}


def thinking_in(body):
    return [b for m in body["messages"] for b in m["content"] if b["type"] in ("thinking", "redacted_thinking")]


async def two_tool_turns(client, stream=False):
    """The messages after two answers that called tools, as the callers keep them: text, tool calls and results."""
    messages = [{"role": "system", "content": "You are Kubeast."}, {"role": "user", "content": "why?"}]
    for _ in range(2):
        answer = await client.chat.completions.create(messages=messages, tools=[TOOL], tool_choice="auto", temperature=0.2,
                                                      max_tokens=900, stream=stream)
        if stream:
            text, calls, _, _ = await consume_like_the_chat_loop(answer)
            calls = [(c["id"], c["name"], c["arguments"]) for c in calls.values()]
        else:
            text = answer.choices[0].message.content
            calls = [(c.id, c.function.name, c.function.arguments) for c in answer.choices[0].message.tool_calls]
        messages.append({"role": "assistant", "content": text, "tool_calls": [
            {"id": i, "type": "function", "function": {"name": n, "arguments": a}} for i, n, a in calls]})
        messages += [{"role": "tool", "tool_call_id": i, "content": f"log of {i}"} for i, _, _ in calls]
    return messages


@pytest.mark.asyncio
@pytest.mark.parametrize("stream", [False, True], ids=["answer", "stream"])
async def test_a_request_with_tools_after_two_tool_turns_is_the_whole_conversation(stream):
    fake = FakeAnthropic([FIRST, SECOND, said("pod-1 is crash looping.")])
    c = client_for(fake)
    messages = await two_tool_turns(c, stream)
    await c.chat.completions.create(messages=messages, tools=[TOOL], tool_choice="auto", temperature=0.2, max_tokens=900)
    assert json.dumps(fake.bodies[2]) == json.dumps({  # the order of the keys too
        "model": "claude-opus-5-5",
        "max_tokens": 900 + am.THINKING_HEADROOM,
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "why?"}]},
            {"role": "assistant", "content": FIRST["content"]},
            {"role": "user", "content": [result_of("toolu_1"), result_of("toolu_2")]},
            {"role": "assistant", "content": SECOND["content"]},
            {"role": "user", "content": [result_of("toolu_3")]},
        ],
        "system": "You are Kubeast.",
        "tools": [{"name": "k8s_get_pod_logs", "description": "", "input_schema": {"type": "object", "properties": {}}}],
        "tool_choice": {"type": "auto"},
        "cache_control": {"type": "ephemeral"},
    })


@pytest.mark.asyncio
@pytest.mark.parametrize("stream", [False, True], ids=["answer", "stream"])
async def test_a_request_without_tools_after_a_tool_loop_carries_no_thinking(stream):
    fake = FakeAnthropic([FIRST, SECOND, said("## Summary"), said("again")])
    c = client_for(fake)
    messages = await two_tool_turns(c, stream)
    out = await c.chat.completions.create(messages=messages + [{"role": "user", "content": "Write the report."}], max_tokens=900)
    assert out.choices[0].message.content == "## Summary" and "tools" not in fake.bodies[2]
    assert fake.bodies[2]["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "why?"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "Looking. "}, log_call("toolu_1", "pod-1"), log_call("toolu_2", "pod-2")]},
        {"role": "user", "content": [result_of("toolu_1"), result_of("toolu_2")]},
        {"role": "assistant", "content": [log_call("toolu_3", "pod-3")]},
        {"role": "user", "content": [result_of("toolu_3"), {"type": "text", "text": "Write the report."}]},
    ]
    await c.chat.completions.create(messages=messages, tools=[TOOL])  # with the tools again, so does the thinking
    assert fake.bodies[3]["messages"][1]["content"] == FIRST["content"]


@pytest.mark.asyncio
@pytest.mark.parametrize("change", [{"tools": [TOOL, TOOL_2]}, {"messages": "system"}, {"messages": "user"}], ids=["tools", "system", "message"])
async def test_the_fake_refuses_a_thinking_block_after_anything_else_than_what_it_was_made_after(change):
    fake = FakeAnthropic([FIRST, SECOND, said("never")])
    c = client_for(fake)
    messages = await two_tool_turns(c)
    if "messages" in change:
        messages = [{**m, "content": "another"} if m["role"] == change["messages"] else m for m in messages]
    with pytest.raises(am.AnthropicAPIError) as e:
        await c.chat.completions.create(messages=messages, tools=change.get("tools", [TOOL]))
    assert e.value.status_code == 400 and e.value.message.startswith("messages.1.content.0: Invalid `signature` in `thinking` block.")


def service_for(fake, provider="anthropic"):
    client = client_for(fake, "claude-haiku-5-5") if provider == "anthropic" else SimpleNamespace(chat=SimpleNamespace(completions=fake))
    return SimpleNamespace(provider=provider, model="claude-haiku-5-5", options={}, client=client)


async def read_log(name, args, step):
    return f"log of {args['pod_name']}"


def assert_goes_on_without_calls(body, before, replies):
    """`body` is the request before it and more: the same system text, tools and messages in front, with the thinking
    first in each turn of `replies`; it may call no tool."""
    assert body["tools"] == before["tools"] and body["tool_choice"] == {"type": "none"} and before["tool_choice"] == {"type": "auto"}
    n = len(before["messages"])
    assert body.get("system") == before.get("system") and body["messages"][:n] == before["messages"] and len(body["messages"]) > n
    turns = [m["content"] for m in body["messages"] if m["role"] == "assistant"]
    assert turns[:len(replies)] == [r["content"] for r in replies] and len(thinking_in(body)) >= len(replies)
    assert {**body, "messages": [], "tool_choice": None} == {**before, "messages": [], "tool_choice": None}  # nothing else differs


@pytest.mark.asyncio
@pytest.mark.parametrize("max_steps", [2, 8, 20])
async def test_the_last_step_of_a_tool_turn_keeps_the_tools_and_calls_none(max_steps):
    steps = [{"content": [{"type": "thinking", "thinking": f"step {n}", "signature": f"sig-{n}"}, log_call(f"toolu_{n}", f"pod-{n}")],
              "stop_reason": "tool_use", "usage": {}} for n in range(1, max_steps)]
    fake = FakeAnthropic([*steps, said("## Summary\nCrash looping.")])
    messages = [{"role": "system", "content": "You are Kubeast."}, {"role": "user", "content": "the alert"}]
    out = await tool_turn.run_tool_turn(service_for(fake), messages, [TOOL], read_log, max_steps=max_steps,
                                        final_message="Write the report.", remaining=lambda: 60.0)
    assert (out.answer, out.steps, len(fake.bodies)) == ("## Summary\nCrash looping.", max_steps, max_steps)
    assert_goes_on_without_calls(fake.bodies[-1], fake.bodies[-2], steps)
    assert fake.bodies[-1]["messages"][-1]["content"][-1] == {"type": "text", "text": "Write the report."}


@pytest.mark.asyncio
async def test_one_more_call_after_a_tool_turn_keeps_the_tools_and_calls_none():
    fake = FakeAnthropic([FIRST, said("## Summary\nfirst"), said("## Summary\nsecond")])
    service, messages = service_for(fake), [{"role": "user", "content": "the alert"}]
    out = await tool_turn.run_tool_turn(service, messages, [TOOL], read_log, max_steps=3, final_message="end", remaining=lambda: 60.0)
    again = messages + [{"role": "assistant", "content": out.answer}, {"role": "user", "content": "Cause 1 has no evidence."}]
    assert await tool_turn.answer_once(service, again, remaining=lambda: 60.0, tools=[TOOL]) == ("## Summary\nsecond", "stop")
    assert_goes_on_without_calls(fake.bodies[2], fake.bodies[1], [FIRST])


@pytest.mark.asyncio
async def test_the_second_ask_of_an_investigation_is_answered(monkeypatch):
    fake = FakeAnthropic([{**SECOND, "content": [THINK, log_call("toolu_i", "pod-1")]}, said("## Summary\nno block"), said("## Summary\nstill none")])
    service = FakeService([])
    service.provider, service.model, service.client = "anthropic", "claude-haiku-5-5", client_for(fake, "claude-haiku-5-5")
    install_loop(monkeypatch, service, [])
    progress = {}
    await runner.investigate(cfg(max_steps=4, evidence_check=True), row(), progress)
    assert progress["evidence"]["asked_again"] is True and progress["evidence"]["ask_failed"] is False
    assert_goes_on_without_calls(fake.bodies[2], fake.bodies[1], [{"content": [THINK, log_call("toolu_i", "pod-1")]}])


@pytest.mark.asyncio
async def test_a_chat_answer_cut_at_its_length_after_tools_goes_on(monkeypatch):
    fake = FakeAnthropic([FIRST, said("It restarts ", "max_tokens"), said("every ", "max_tokens"), said("minute.")])
    events = await chat_turn(monkeypatch, client_for(fake, "claude-haiku-5-5"))
    parsed = [json.loads(e[len("data: "):]) for e in events if e.startswith("data: {")]
    assert "".join(p["content"] for p in parsed if "content" in p) == "Looking. It restarts every minute."
    assert not [p for p in parsed if "error" in p] and len(fake.bodies) == 4  # no refusal, no second try
    assert_goes_on_without_calls(fake.bodies[2], fake.bodies[1], [FIRST])
    assert fake.bodies[3]["messages"][:len(fake.bodies[2]["messages"])] == fake.bodies[2]["messages"]
    assert fake.bodies[3]["tools"] == fake.bodies[2]["tools"] and fake.bodies[3]["tool_choice"] == {"type": "none"}


class OtherProvider:
    """An OpenAI-compatible model that calls a tool once, then answers; it keeps each request's arguments."""

    def __init__(self, *answers):
        self.seen, self.answers = [], list(answers)

    async def create(self, **kw):
        self.seen.append({**kw, "messages": list(kw["messages"])})
        if kw.get("stream"):
            async def chunks():
                yield chunk(tool_call="k8s_get_pod_logs", finish_reason="tool_calls") if len(self.seen) == 1 else chunk(*self.answers.pop(0))
            return chunks()
        call = SimpleNamespace(id="c1", function=SimpleNamespace(name="k8s_get_pod_logs", arguments='{"pod_name": "p"}'))
        msg = SimpleNamespace(content="", tool_calls=[call]) if len(self.seen) == 1 else SimpleNamespace(content=self.answers.pop(0), tool_calls=None)
        return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason="stop")], usage=None)


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["openai", "azure", "gemini", "ollama", "custom"])
async def test_on_another_provider_these_calls_carry_no_tools(monkeypatch, provider):
    model = OtherProvider("report", "second")
    service, messages = service_for(model, provider), [{"role": "user", "content": "the alert"}]
    out = await tool_turn.run_tool_turn(service, messages, [TOOL], read_log, max_steps=2, final_message="end", remaining=lambda: 60.0)
    assert (out.answer, model.seen[0]["tools"], model.seen[0]["tool_choice"]) == ("report", [TOOL], "auto")
    assert await tool_turn.answer_once(service, messages, remaining=lambda: 60.0, tools=[TOOL]) == ("second", "stop")
    assert [set(kw) for kw in model.seen[1:]] == [{"model", "messages", "temperature", "max_tokens", "timeout"}] * 2

    chat = OtherProvider(("It restarts ", None, "length"), ("every minute.", None, "stop"))
    await chat_turn(monkeypatch, SimpleNamespace(chat=SimpleNamespace(completions=chat)), provider=provider)
    assert chat.seen[0]["tools"] == [TOOL] and len(chat.seen) == 3
    assert set(chat.seen[2]) == {"model", "messages", "temperature", "max_tokens", "stream", "stream_options"}
