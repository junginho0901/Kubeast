"""A thinking model's reasoning text goes back to the endpoint that wrote it, in both tool loops (app/services/ai/reasoning_text.py).

DeepSeek's thinking mode answers with `reasoning_content` and refuses with a 400 the next request of a tool loop whose
assistant message comes back without it (api-docs.deepseek.com "Thinking mode"); Together's thinking models give
`reasoning` (or `reasoning_content`) and take it back under the same key (docs.together.ai "OpenAI API compatibility").
The answers below are in those shapes. On an OpenAI-compatible endpoint the field the answer gave stays on that assistant
message for the loop's next requests; the providers reached at their own API send the bytes they sent before whatever
their answers hold; the saved answer, the audit rows and the next turn's history hold none of it. A fake endpoint stands
for each provider: these tests make no model call."""
import json
from types import SimpleNamespace

import httpx
import pytest

from app.services import provider_adapter
from app.services.ai import reasoning_text
from app.services.ai.tool_turn import run_tool_turn, server_calls
from app.services.provider_adapter import ProviderAdapter
from tests.test_anthropic_messages import FIRST, SECOND, FakeAnthropic, said

TOOLS = [{"type": "function", "function": {"name": "list_clusters", "parameters": {"type": "object", "properties": {}}}}]
USAGE = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
REAL_CLIENT = httpx.AsyncClient  # a second fake endpoint in one test is made from the real client, not the first fake
DEEPSEEK = ("custom", "https://api.deepseek.com", "deepseek-v4-pro")
TOGETHER = ("custom", "https://api.together.ai/v1", "deepseek-ai/DeepSeek-V4-Pro-0813")
# The providers reached at their own API, and Ollama at an address of its own.
OWN_API = [("openai", None, "gpt-4o-mini"), ("azure", "https://res.openai.azure.com/openai/v1/", "prod-chat"),
           ("google", None, "gemini-3-pro-preview"), ("gemini", None, "gemini-3-flash-preview"), ("ollama", None, "qwen3"),
           ("ollama", "http://ollama.ai.svc:11434/v1", "gpt-oss:20b")]
BOTH = ("reasoning_content", "reasoning")


def thoughts(keys, n):
    return {key: f"{key} {n}: read the clusters first" for key in keys}


def call(cid):
    return {"id": cid, "type": "function", "function": {"name": "list_clusters", "arguments": "{}"}}


def answer(keys, n, *calls, content=None):
    message = {"role": "assistant", "content": content, **thoughts(keys, n)}
    if calls:
        message["tool_calls"] = [call(c) for c in calls]
    return {"id": "r", "object": "chat.completion", "created": 0, "model": "m", "usage": USAGE,
            "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if calls else "stop"}]}


def chunk(delta, finish=None):
    return {"id": "r", "object": "chat.completion.chunk", "created": 0, "model": "m",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}


def sse(*chunks):
    lines = [f"data: {json.dumps(c)}\n\n" for c in chunks]
    lines.append(f"data: {json.dumps({'id': 'r', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'm', 'choices': [], 'usage': USAGE})}\n\n")
    lines.append("data: [DONE]\n\n")
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content="".join(lines).encode())


def pieces(keys, n):
    """The reasoning of answer n streamed in two pieces per key, before the rest, as these endpoints stream it."""
    whole = thoughts(keys, n)
    return [chunk({"role": "assistant", **{k: v[:9] for k, v in whole.items()}}), chunk({k: v[9:] for k, v in whole.items()})]


def streamed_call(keys):
    head = {"index": 0, "id": "fc-1", "type": "function", "function": {"name": "list_clusters", "arguments": ""}}
    return sse(*pieces(keys, 1), chunk({"tool_calls": [head]}),
               chunk({"tool_calls": [{"index": 0, "function": {"arguments": "{}"}}]}, finish="tool_calls"))


def streamed_text(keys, text="Two clusters."):
    return sse(*pieces(keys, 2), chunk({"content": text}, finish="stop"))


def serve(monkeypatch, replies=None, handler=None):
    """The adapter's httpx client against a fake endpoint that gives `replies` in turn (or `handler`); returns the
    request bodies as sent, bytes."""
    bodies = []

    def answer_in_turn(request):
        reply = replies.pop(0)
        return reply if isinstance(reply, httpx.Response) else httpx.Response(200, json=reply)

    def capture(request):
        bodies.append(request.content)
        return (handler or answer_in_turn)(request)

    class Fake(REAL_CLIENT):
        def __init__(self, **_kw):
            super().__init__(transport=httpx.MockTransport(capture))

    monkeypatch.setattr(httpx, "AsyncClient", Fake)
    provider_adapter._refused.clear()
    provider_adapter._without_reasoning.clear()
    provider_adapter._reasoning_refused.clear()
    return bodies


def loads(bodies):
    return [json.loads(b) for b in bodies]


def service_for(provider, base_url, model, api_key="k"):
    return SimpleNamespace(provider=provider, model=model, options={},
                           client=ProviderAdapter(provider=provider, model=model, api_key=api_key, base_url=base_url))


async def run_tool(name, args, step):
    return f"{name} answered at step {step}"


async def investigate(service, max_steps=4):
    """The investigator's loop: step 0's reads the server made, then the model's own calls."""
    reads = [("timeline", {"view": "changes"}, "[call 1] no changes")]
    messages = [{"role": "system", "content": "You investigate."}, {"role": "user", "content": "Pod web-1 restarts."},
                *server_calls(SimpleNamespace(options={}), reads)]
    out = await run_tool_turn(service, messages, TOOLS, run_tool, max_steps=max_steps, final_message="Answer now.",
                              remaining=lambda: 60.0)
    return out, messages


def model_steps(body):
    return [m for m in body["messages"] if m.get("role") == "assistant" and m.get("tool_calls")
            and not m["tool_calls"][0]["id"].startswith("kubeast_step0_")]


def step(cid, keys, n):
    return {"role": "assistant", "content": "", "tool_calls": [call(cid)], **thoughts(keys, n)}


# --- which endpoints keep it -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("provider,base_url,keeps", [
    ("custom", "https://api.deepseek.com", True), ("deepseek", "https://api.deepseek.com", True),
    ("together", "https://api.together.ai/v1", True), ("openai", "https://gw.internal/v1", True),
    ("openai", None, False), ("openai", " ", False), ("", None, False), (None, None, False),
    ("azure", "https://res.openai.azure.com/openai/v1/", False), ("azureopenai", "https://res.openai.azure.com/openai/v1/", False),
    ("anthropic", None, False), ("google", None, False), ("gemini", "https://gw.internal/v1", False),
    ("ollama", None, False), ("ollama", "http://ollama.ai.svc:11434/v1", False), ("claude-code", None, False)])
def test_an_openai_compatible_endpoint_keeps_it_and_a_providers_own_api_does_not(provider, base_url, keeps):
    assert reasoning_text.applies(provider, base_url) is keeps
    if provider not in (None, "", "custom", "deepseek", "together", "claude-code"):
        assert ProviderAdapter(provider=provider, model="m", api_key="k", base_url=base_url).reasoning_back is keeps


def test_kept_reads_a_response_message_or_a_collected_dict_and_only_text_that_is_not_empty():
    keeps = SimpleNamespace(client=SimpleNamespace(reasoning_back=True))
    message = SimpleNamespace(reasoning_content="why", reasoning=None)
    assert reasoning_text.kept(keeps, message) == {"reasoning_content": "why"}
    assert reasoning_text.kept(keeps, {"reasoning": "why", "reasoning_content": ""}) == {"reasoning": "why"}
    assert reasoning_text.kept(keeps, {"reasoning": ["not", "text"]}) == {}
    for other in (SimpleNamespace(client=SimpleNamespace(reasoning_back=False)), SimpleNamespace(client=SimpleNamespace()),
                  SimpleNamespace(client=SimpleNamespace(reasoning_back="yes")), SimpleNamespace()):
        assert reasoning_text.kept(other, message) == {}
        held = {}
        reasoning_text.add_delta(other, held, message)
        assert held == {}


# --- the investigator's loop ---------------------------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint,keys", [(DEEPSEEK, ("reasoning_content",)), (TOGETHER, ("reasoning",)), (TOGETHER, BOTH)],
                         ids=["deepseek", "together", "both-keys"])
async def test_each_step_of_the_tool_loop_goes_back_with_its_own_reasoning_under_the_key_it_came_with(monkeypatch, endpoint, keys):
    bodies = serve(monkeypatch, [answer(keys, 1, "fc-1"), answer(keys, 2, "fc-2"), answer(keys, 3, content="It is OOMKilled.")])
    out, messages = await investigate(service_for(*endpoint))
    sent = loads(bodies)
    assert out.answer == "It is OOMKilled." and len(sent) == 3
    assert model_steps(sent[0]) == []
    assert model_steps(sent[1]) == [step("fc-1", keys, 1)]
    assert model_steps(sent[2]) == [step("fc-1", keys, 1), step("fc-2", keys, 2)]
    # step 0's message is the server's: nothing is added to it
    assert sent[2]["messages"][2] == sent[0]["messages"][2] and not set(BOTH) & set(sent[2]["messages"][2])
    # what the loop gives its caller holds none of it: the answer, the subscription's results
    assert "read the clusters" not in out.answer + json.dumps(out.results)
    assert sum(1 for m in messages if set(BOTH) & set(m)) == 2  # the loop's own history, in memory


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base_url,model", OWN_API)
async def test_a_providers_own_api_sends_the_bytes_it_sent_before_whatever_its_answers_hold(monkeypatch, provider, base_url, model):
    plain = serve(monkeypatch, [answer((), 1, "fc-1"), answer((), 2, "fc-2"), answer((), 3, content="Done.")])
    await investigate(service_for(provider, base_url, model))
    thinking = serve(monkeypatch, [answer(BOTH, 1, "fc-1"), answer(BOTH, 2, "fc-2"), answer(BOTH, 3, content="Done.")])
    await investigate(service_for(provider, base_url, model))
    assert len(plain) == 3 and thinking == plain


@pytest.mark.asyncio
async def test_anthropic_sends_the_bytes_it_sent_before_whatever_its_answers_hold(monkeypatch):
    def replies(extra):
        return [{**FIRST, **extra}, {**SECOND, **extra}, {**said("Done."), **extra}]

    plain = serve(monkeypatch, handler=FakeAnthropic(replies({})))
    await investigate(service_for("anthropic", None, "claude-haiku-5-5", api_key="sk-ant-test"))
    thinking = serve(monkeypatch, handler=FakeAnthropic(replies(thoughts(BOTH, 1))))
    out, _ = await investigate(service_for("anthropic", None, "claude-haiku-5-5", api_key="sk-ant-test"))
    assert out.answer == "Done." and len(plain) == 3 and thinking == plain


# --- the chat's streaming loop -------------------------------------------------------------------------------------------


class Kept:
    """What a chat turn saved and audited."""

    def __init__(self):
        self.saved, self.audits = [], []


def chat_service(monkeypatch, provider, base_url, model, kept, history=(), api_key="k"):
    from app.services.ai import streaming

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            kept.saved.append({"role": role, "content": content, **kw})

        async def get_messages(self, sid):
            return [*history, SimpleNamespace(role="user", content="clusters?")]

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            pass

        async def update_session_title(self, sid, title):
            pass

    async def get_db_service():
        return DB()

    async def audit(**kw):
        kept.audits.append(kw)
        return True

    async def no_budget(*a, **kw):
        return None

    async def same_tools(tools, service):
        return tools

    async def execute(name, args, ctx):
        return json.dumps([{"name": "self"}, {"name": "default"}])

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", audit)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr("app.services.ai.features.gate_tools", same_tools)
    return SimpleNamespace(
        model=model, provider=provider, user_role="read", tier="default", cluster_name="self", options={},
        client=ProviderAdapter(provider=provider, model=model, api_key=api_key, base_url=base_url),
        tool_contexts={}, tool_server=SimpleNamespace(last_redacted=None),
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=lambda message: "Answer in English.",
        _get_tools_definition=lambda: TOOLS,
        _filter_tools_for_output_preference=lambda tools, message: tools,
        _execute_function_with_context=execute,
    )


async def chat(service):
    from app.services.ai import streaming

    events = [e async for e in streaming.session_chat_stream(service, "s1", "clusters?",
                                                              audit_actor={"user_id": "u1", "email": "u1@example.com"})]
    assert not any('"error"' in e for e in events), events
    return events


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint,keys", [(DEEPSEEK, ("reasoning_content",)), (TOGETHER, ("reasoning",)), (TOGETHER, BOTH)],
                         ids=["deepseek", "together", "both-keys"])
async def test_the_chat_sends_a_streamed_reasoning_back_whole_on_the_step_it_came_with(monkeypatch, endpoint, keys):
    kept = Kept()
    bodies = serve(monkeypatch, [streamed_call(keys), streamed_text(keys)])
    events = await chat(chat_service(monkeypatch, *endpoint, kept))
    sent = loads(bodies)
    assert len(sent) == 2 and sent[0]["stream"] is True
    assert model_steps(sent[0]) == []
    assert model_steps(sent[1]) == [{"role": "assistant", "content": None, "tool_calls": [call("fc-1")], **thoughts(keys, 1)}]
    roles = [m["role"] for m in sent[1]["messages"]]
    assert roles[roles.index("assistant"):] == ["assistant", "tool"]
    # the screen, the saved answer and the audit rows get none of it
    assert "read the clusters" not in json.dumps(events, ensure_ascii=False)
    assert kept.saved and kept.audits
    assert "read the clusters" not in json.dumps(kept.saved, ensure_ascii=False, default=str)
    assert "read the clusters" not in json.dumps(kept.audits, ensure_ascii=False, default=str)


@pytest.mark.asyncio
async def test_the_next_turns_history_does_not_grow_with_it(monkeypatch):
    kept = Kept()
    serve(monkeypatch, [streamed_call(BOTH[:1]), streamed_text(BOTH[:1])])
    await chat(chat_service(monkeypatch, *DEEPSEEK, kept))
    history = [SimpleNamespace(role=m["role"], content=m["content"]) for m in kept.saved]
    assert [m.role for m in history] == ["user", "assistant"]

    again = Kept()
    bodies = serve(monkeypatch, [streamed_text(BOTH[:1], "Still two.")])
    await chat(chat_service(monkeypatch, *DEEPSEEK, again, history=history))
    [first] = loads(bodies)
    assert [m["role"] for m in first["messages"] if m["role"] != "system"] == ["user", "assistant", "user"]
    assert not any(set(BOTH) & set(m) for m in first["messages"])
    assert "read the clusters" not in json.dumps(first, ensure_ascii=False)


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base_url,model", OWN_API)
async def test_the_chat_on_a_providers_own_api_sends_the_bytes_it_sent_before_whatever_its_answers_hold(
        monkeypatch, provider, base_url, model):
    plain = serve(monkeypatch, [streamed_call(()), streamed_text(())])
    await chat(chat_service(monkeypatch, provider, base_url, model, Kept()))
    thinking = serve(monkeypatch, [streamed_call(BOTH), streamed_text(BOTH)])
    await chat(chat_service(monkeypatch, provider, base_url, model, Kept()))
    assert len(plain) == 2 and thinking == plain


@pytest.mark.asyncio
async def test_the_chat_on_anthropic_sends_the_bytes_it_sent_before_whatever_its_answers_hold(monkeypatch):
    plain = serve(monkeypatch, handler=FakeAnthropic([FIRST, said("Two clusters.")]))
    await chat(chat_service(monkeypatch, "anthropic", None, "claude-haiku-5-5", Kept(), api_key="sk-ant-test"))
    extra = thoughts(BOTH, 1)
    thinking = serve(monkeypatch, handler=FakeAnthropic([{**FIRST, **extra}, {**said("Two clusters."), **extra}]))
    await chat(chat_service(monkeypatch, "anthropic", None, "claude-haiku-5-5", Kept(), api_key="sk-ant-test"))
    assert len(plain) == 2 and thinking == plain


# --- an endpoint that refuses it ------------------------------------------------------------------------------------------


def refusing(replies, refusal):
    """An endpoint that answers 400 `refusal` to a request carrying either field, else the next of `replies`."""
    def handler(request):
        body = json.loads(request.content)
        if any(set(BOTH) & set(m) for m in body["messages"]):
            return httpx.Response(400, json={"error": {"message": refusal, "type": "invalid_request_error", "param": None, "code": None}})
        return httpx.Response(200, json=replies.pop(0))
    return handler


@pytest.mark.asyncio
async def test_an_endpoint_that_refuses_the_field_gets_the_request_again_without_it_and_from_then_on(monkeypatch):
    refusal = "'messages.3' : for 'role:assistant' the following must be satisfied[('messages.3' : property 'reasoning' is unsupported)]"
    replies = [answer(("reasoning",), 1, "fc-1"), answer(("reasoning",), 2, "fc-2"), answer(("reasoning",), 3, content="Done.")]
    bodies = serve(monkeypatch, handler=refusing(replies, refusal))
    out, _ = await investigate(service_for(*TOGETHER))
    sent = loads(bodies)
    assert out.answer == "Done."
    # the second call is refused once and sent again without it; the third leaves it out at once
    assert [bool(any(set(BOTH) & set(m) for m in b["messages"])) for b in sent] == [False, True, False, False]
    assert sent[2]["messages"] == [{k: v for k, v in m.items() if k != "reasoning"} for m in sent[1]["messages"]]
    assert ("custom", "https://api.together.ai/v1", TOGETHER[2]) in provider_adapter._reasoning_refused


@pytest.mark.asyncio
async def test_a_400_asking_for_it_back_is_sent_once_without_it_and_not_remembered(monkeypatch):
    refusal = "The reasoning_content in the thinking mode must be passed back to the API."
    bodies = serve(monkeypatch, handler=lambda request: httpx.Response(
        400, json={"error": {"message": refusal, "type": "invalid_request_error", "param": None, "code": "invalid_request_error"}}))
    messages = [{"role": "user", "content": "why?"}, step("fc-1", ("reasoning_content",), 1),
                {"role": "tool", "tool_call_id": "fc-1", "content": "two"}]
    service = service_for(*DEEPSEEK)
    with pytest.raises(Exception) as err:
        await service.client.chat.completions.create(model=DEEPSEEK[2], messages=messages, tools=TOOLS)
    assert getattr(err.value, "status_code", None) == 400
    sent = loads(bodies)
    assert len(sent) == 2 and "reasoning_content" in sent[0]["messages"][1] and "reasoning_content" not in sent[1]["messages"][1]
    assert provider_adapter._reasoning_refused == set()
    assert messages[1]["reasoning_content"]  # the caller's history is as it was


def test_a_refusal_names_the_field_as_a_word_for_a_request_that_carried_one():
    carried = [{"role": "assistant", "content": "", "reasoning": "x"}]

    def err(text, status=400):
        e = Exception(text)
        e.status_code = status
        return e

    assert reasoning_text.refused(err("property 'reasoning' is unsupported"), carried)
    assert reasoning_text.refused(err("Extra inputs are not permitted: messages.1.reasoning_content"), carried)
    assert not reasoning_text.refused(err("function tools with reasoning_effort are not supported"), carried)
    assert not reasoning_text.refused(err("property 'reasoning' is unsupported", 500), carried)
    assert not reasoning_text.refused(err("property 'reasoning' is unsupported"), [{"role": "assistant", "content": ""}])
    assert reasoning_text.without(carried) == [{"role": "assistant", "content": ""}] and carried[0]["reasoning"] == "x"
    plain = [{"role": "user", "content": "why?"}]
    assert reasoning_text.without(plain) is plain
