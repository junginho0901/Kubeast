"""Gemini 3 and later sign the first function call of each step and refuse with a 400 a request whose current turn
holds a step whose first call comes back unsigned (ai.google.dev and Vertex AI "Thought signatures"; through the
OpenAI-compatible endpoint the signature is the call's `extra_content.google.thought_signature`). On provider google a
call's `extra_content` stays on it in the history, as received, and goes back in the next request body, in both tool
loops; the calls the server made itself (the investigator's step 0) get Google's placeholder, and a call of the model's
that came without a signature goes back as it came. Other providers' request bodies are as before. A fake endpoint stands for each provider: these tests make no model call."""
import copy
import json
from types import SimpleNamespace

import httpx
import pytest

from app.services import provider_adapter
from app.services.ai import thought_signatures
from app.services.ai.thought_signatures import PLACEHOLDER, SERVER_CALL_ID
from app.services.ai.tool_turn import run_tool_turn, server_calls
from app.services.provider_adapter import ProviderAdapter

TOOLS = [{"type": "function", "function": {"name": "list_clusters", "parameters": {"type": "object", "properties": {}}}}]
AZURE = "https://res.openai.azure.com/openai/v1/"
USAGE = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}


def call(cid, name="list_clusters", args=None, signature=None):
    out = {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args or {})}}
    if signature:
        out["extra_content"] = {"google": {"thought_signature": signature}}
    return out


def answer(*calls, content=None):
    message = {"role": "assistant", "content": content}
    if calls:
        message["tool_calls"] = list(calls)
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


def serve(monkeypatch, replies):
    """The adapter's httpx client against a fake endpoint that gives `replies` in turn; returns the request bodies."""
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        reply = replies.pop(0)
        return reply if isinstance(reply, httpx.Response) else httpx.Response(200, json=reply)

    class Fake(httpx.AsyncClient):
        def __init__(self, **_kw):
            super().__init__(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(httpx, "AsyncClient", Fake)
    provider_adapter._refused.clear()
    provider_adapter._without_reasoning.clear()
    return bodies


def service_for(provider, model="gemini-3-pro-preview", base_url=None):
    return SimpleNamespace(provider=provider, model=model, options={},
                           client=ProviderAdapter(provider=provider, model=model, api_key="k", base_url=base_url))


async def turn(service, max_steps=4):
    messages = [{"role": "system", "content": "You investigate."}, {"role": "user", "content": "Pod web-1 restarts."}]

    async def run_tool(name, args, step):
        return f"{name} answered at step {step}"

    out = await run_tool_turn(service, messages, TOOLS, run_tool, max_steps=max_steps, final_message="Answer now.",
                              remaining=lambda: 60.0)
    return out, messages


def assistant_steps(body):
    return [m for m in body["messages"] if m.get("role") == "assistant" and m.get("tool_calls")]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["google", "gemini"])
async def test_a_google_calls_signature_goes_back_on_that_call_in_the_next_request_body(monkeypatch, provider):
    bodies = serve(monkeypatch, [answer(call("fc-1", signature="SIG_A")), answer(content="It is OOMKilled.")])
    out, _ = await turn(service_for(provider))
    assert out.answer == "It is OOMKilled."
    assert len(bodies) == 2
    [step] = assistant_steps(bodies[1])
    assert step["tool_calls"] == [call("fc-1", signature="SIG_A")]
    assert [m["role"] for m in bodies[1]["messages"]] == ["system", "user", "assistant", "tool"]


@pytest.mark.asyncio
async def test_each_step_of_a_turn_keeps_its_own_signature(monkeypatch):
    bodies = serve(monkeypatch, [answer(call("fc-1", signature="SIG_A")), answer(call("fc-2", "list_pods", signature="SIG_B")),
                                 answer(content="Done.")])
    out, _ = await turn(service_for("google"))
    assert out.answer == "Done." and len(bodies) == 3
    steps = assistant_steps(bodies[2])
    assert [s["tool_calls"] for s in steps] == [[call("fc-1", signature="SIG_A")], [call("fc-2", "list_pods", signature="SIG_B")]]


@pytest.mark.asyncio
async def test_parallel_calls_go_back_as_received_the_first_signed_then_every_call_then_every_result(monkeypatch):
    first = call("fc-paris", args={"cluster": "paris"}, signature="SIG_A")
    second = call("fc-london", args={"cluster": "london"})
    bodies = serve(monkeypatch, [answer(first, second), answer(content="Both answered.")])
    await turn(service_for("google"))
    sent = bodies[1]["messages"]
    assert [m["role"] for m in sent] == ["system", "user", "assistant", "tool", "tool"]
    assert sent[2]["tool_calls"] == [first, second]  # the second unsigned, as Google gave it, and no placeholder
    assert [m["tool_call_id"] for m in sent[3:]] == ["fc-paris", "fc-london"]


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gemini-2.5-flash", "gemini-3-pro-preview"])
async def test_a_call_the_model_made_without_a_signature_goes_back_as_it_came_with_no_placeholder(monkeypatch, model):
    """Gemini 2.5 with thinking off signs nothing; Google calls the placeholder a last resort, for calls the model did not make."""
    bodies = serve(monkeypatch, [answer(call("fc-1")), answer(call("fc-2", "list_pods")), answer(content="Done.")])
    await turn(service_for("google", model=model))
    assert len(bodies) == 3
    assert [s["tool_calls"] for s in assistant_steps(bodies[2])] == [[call("fc-1")], [call("fc-2", "list_pods")]]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,base_url,model", [
    ("openai", None, "gpt-4o-mini"), ("ollama", None, "llama3.1"), ("azure", AZURE, "prod-chat"),
    ("custom", "https://gw.internal/v1", "team-default")])
async def test_other_providers_send_the_call_back_as_before_even_when_their_answer_held_more(
        monkeypatch, provider, base_url, model):
    bodies = serve(monkeypatch, [answer(call("fc-1", signature="SIG_A")), answer(content="Fine.")])
    await turn(service_for(provider, model=model, base_url=base_url))
    [step] = assistant_steps(bodies[1])
    assert step == {"role": "assistant", "content": "",
                    "tool_calls": [{"id": "fc-1", "type": "function", "function": {"name": "list_clusters", "arguments": "{}"}}]}


def step_zero_messages():
    """The investigator's step 0 as the API-key path sends it: reads the server made itself after the first message."""
    return [
        {"role": "system", "content": "You investigate."},
        {"role": "user", "content": "Pod web-1 restarts. Step 0 read the changes as [call 1] and the ranking as [call 2]."},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": f"{SERVER_CALL_ID}1", "type": "function", "function": {"name": "timeline", "arguments": '{"view": "changes"}'}},
            {"id": f"{SERVER_CALL_ID}2", "type": "function", "function": {"name": "anomaly_rank", "arguments": "{}"}},
        ]},
        {"role": "tool", "tool_call_id": f"{SERVER_CALL_ID}1", "content": "[call 1] no changes"},
        {"role": "tool", "tool_call_id": f"{SERVER_CALL_ID}2", "content": "[call 2] web-1 first"},
    ]


@pytest.mark.asyncio
async def test_reads_the_server_made_before_the_first_model_call_carry_googles_placeholder_on_google_only(monkeypatch):
    bodies = serve(monkeypatch, [answer(content="ok"), answer(content="ok")])
    messages = step_zero_messages()
    kept = copy.deepcopy(messages)
    await ProviderAdapter(provider="google", model="gemini-3-pro-preview", api_key="k").chat.completions.create(
        model="gemini-3-pro-preview", messages=messages, tools=TOOLS)
    [step] = assistant_steps(bodies[0])
    assert step["tool_calls"][0]["extra_content"] == {"google": {"thought_signature": PLACEHOLDER}}
    assert "extra_content" not in step["tool_calls"][1]  # the first call of a step only, as the model signs
    assert messages == kept  # the history keeps what the server made; the placeholder is in the request only

    await ProviderAdapter(provider="openai", model="gpt-4o-mini", api_key="k").chat.completions.create(
        model="gpt-4o-mini", messages=messages, tools=TOOLS)
    assert bodies[1]["messages"] == kept


@pytest.mark.asyncio
async def test_step_zeros_call_ids_come_from_server_call_id_so_google_gives_its_first_call_the_placeholder(monkeypatch):
    monkeypatch.setattr(thought_signatures, "SERVER_CALL_ID", "renamed_step0_")  # the ids and the placeholder follow the one prefix
    bodies = serve(monkeypatch, [answer(content="ok")])
    reads = [("timeline", {"view": "changes"}, "[call 1] no changes"), ("anomaly_rank", {}, "[call 2] web-1 first")]
    messages = [{"role": "system", "content": "You investigate."}, {"role": "user", "content": "Pod web-1 restarts."},
                *server_calls(SimpleNamespace(options={}), reads)]
    await ProviderAdapter(provider="google", model="gemini-3-pro-preview", api_key="k").chat.completions.create(
        model="gemini-3-pro-preview", messages=messages, tools=TOOLS)
    [step] = assistant_steps(bodies[0])
    assert [c["id"] for c in step["tool_calls"]] == ["renamed_step0_1", "renamed_step0_2"]
    assert step["tool_calls"][0]["extra_content"] == {"google": {"thought_signature": PLACEHOLDER}}
    assert "extra_content" not in step["tool_calls"][1]


def test_only_the_servers_calls_of_the_current_turn_get_the_placeholder():
    older = {"role": "assistant", "content": "", "tool_calls": [call(f"{SERVER_CALL_ID}1")]}
    server = {"role": "assistant", "content": "", "tool_calls": [call(f"{SERVER_CALL_ID}1"), call(f"{SERVER_CALL_ID}2")]}
    signed = {"role": "assistant", "content": "", "tool_calls": [call("fc-1", signature="SIG_A")]}
    unsigned = {"role": "assistant", "content": "", "tool_calls": [call("fc-2")]}
    messages = [{"role": "user", "content": "first question"}, older, {"role": "tool", "tool_call_id": f"{SERVER_CALL_ID}1", "content": "x"},
                {"role": "assistant", "content": "An answer."}, {"role": "user", "content": "second question"},
                server, {"role": "tool", "tool_call_id": f"{SERVER_CALL_ID}1", "content": "w"},
                signed, {"role": "tool", "tool_call_id": "fc-1", "content": "y"},
                unsigned, {"role": "tool", "tool_call_id": "fc-2", "content": "z"}]
    out = thought_signatures.sent(messages)
    assert out[1] is older  # before the last user message: not checked by Google, sent as it is
    assert out[5]["tool_calls"][0]["extra_content"] == {"google": {"thought_signature": PLACEHOLDER}}
    assert out[5]["tool_calls"][1] == call(f"{SERVER_CALL_ID}2")  # the first call of a step only
    assert out[7] is signed  # a real signature is never replaced
    assert out[9] is unsigned  # the model's own call without a signature goes as it came
    assert "extra_content" not in server["tool_calls"][0]
    # a turn with no call of the server's, or with no step yet, goes as the same list
    model_turn, no_step = messages[:5] + messages[7:], messages[:5]
    assert thought_signatures.sent(model_turn) is model_turn
    assert thought_signatures.sent(no_step) is no_step


def test_a_placeholder_keeps_what_else_the_call_carried_and_the_history_is_kept_for_other_providers():
    step = {"role": "assistant", "content": "", "tool_calls": [{**call(f"{SERVER_CALL_ID}1"), "extra_content": {"google": {"other": 1}, "x": 2}}]}
    [out] = thought_signatures.sent([step])
    assert out["tool_calls"][0]["extra_content"] == {"google": {"other": 1, "thought_signature": PLACEHOLDER}, "x": 2}
    assert step["tool_calls"][0]["extra_content"] == {"google": {"other": 1}, "x": 2}
    response_call = SimpleNamespace(id="fc-1", extra_content={"google": {"thought_signature": "SIG_A"}})
    assert thought_signatures.kept("google", response_call) == {"extra_content": {"google": {"thought_signature": "SIG_A"}}}
    for provider in ("openai", "anthropic", "azure", "ollama", "claude-code", "", None):
        assert thought_signatures.kept(provider, response_call) == {}
    assert thought_signatures.kept("google", SimpleNamespace(id="fc-1")) == {}


# --- the chat's streaming loop -------------------------------------------------------------------------------------------


def chat_service(monkeypatch, provider, model, base_url=None):
    from app.services.ai import streaming

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            return None

        async def get_messages(self, sid):
            return [SimpleNamespace(role="user", content="clusters?")]

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            pass

        async def update_session_title(self, sid, title):
            pass

    async def get_db_service():
        return DB()

    async def no_audit(**kw):
        return True

    async def no_budget(*a, **kw):
        return None

    async def same_tools(tools, service):
        return tools

    async def execute(name, args, ctx):
        return json.dumps([{"name": "self"}, {"name": "default"}])

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", no_audit)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr("app.services.ai.features.gate_tools", same_tools)
    return SimpleNamespace(
        model=model, provider=provider, user_role="read", tier="default", cluster_name="self", options={},
        client=ProviderAdapter(provider=provider, model=model, api_key="k", base_url=base_url),
        tool_contexts={}, tool_server=SimpleNamespace(last_redacted=None),
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=lambda message: "Answer in English.",
        _get_tools_definition=lambda: TOOLS,
        _filter_tools_for_output_preference=lambda tools, message: tools,
        _execute_function_with_context=execute,
    )


def streamed_calls(where):
    """Two calls streamed as a provider may stream them: the signature on the call's first chunk or on a later one."""
    signature = {"extra_content": {"google": {"thought_signature": "SIG_S"}}}
    head = {"index": 0, "id": "fc-1", "type": "function", "function": {"name": "list_clusters", "arguments": ""}}
    tail = {"index": 0, "function": {"arguments": "{}"}}
    other = {"index": 1, "id": "fc-2", "type": "function", "function": {"name": "list_clusters", "arguments": "{}"}}
    if where == "first chunk":
        head.update(signature)
    else:
        tail.update(signature)
    return sse(chunk({"role": "assistant", "tool_calls": [head]}), chunk({"tool_calls": [tail]}),
               chunk({"tool_calls": [other]}, finish="tool_calls"))


@pytest.mark.asyncio
@pytest.mark.parametrize("where", ["first chunk", "later chunk"])
async def test_the_chat_sends_a_streamed_calls_signature_back_on_google(monkeypatch, where):
    from app.services.ai import streaming

    bodies = serve(monkeypatch, [streamed_calls(where), sse(chunk({"content": "Two clusters."}, finish="stop"))])
    service = chat_service(monkeypatch, "google", "gemini-3-flash-preview")
    events = [e async for e in streaming.session_chat_stream(service, "s1", "clusters?")]
    assert not any('"error"' in e for e in events), events
    assert len(bodies) == 2 and bodies[0]["stream"] is True
    [step] = assistant_steps(bodies[1])
    assert step["tool_calls"] == [
        {"id": "fc-1", "type": "function", "function": {"name": "list_clusters", "arguments": "{}"},
         "extra_content": {"google": {"thought_signature": "SIG_S"}}},
        {"id": "fc-2", "type": "function", "function": {"name": "list_clusters", "arguments": "{}"}},
    ]
    roles = [m["role"] for m in bodies[1]["messages"]]
    assert roles[roles.index("assistant"):] == ["assistant", "tool", "tool"]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,model,base_url", [("openai", "gpt-4o-mini", None), ("ollama", "llama3.1", None)])
async def test_the_chat_sends_other_providers_streamed_calls_back_as_before(monkeypatch, provider, model, base_url):
    from app.services.ai import streaming

    bodies = serve(monkeypatch, [streamed_calls("first chunk"), sse(chunk({"content": "Two clusters."}, finish="stop"))])
    service = chat_service(monkeypatch, provider, model, base_url)
    [e async for e in streaming.session_chat_stream(service, "s1", "clusters?")]
    [step] = assistant_steps(bodies[1])
    assert step["tool_calls"] == [
        {"id": "fc-1", "type": "function", "function": {"name": "list_clusters", "arguments": "{}"}},
        {"id": "fc-2", "type": "function", "function": {"name": "list_clusters", "arguments": "{}"}},
    ]
