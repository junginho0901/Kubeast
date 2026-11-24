"""A chat question that needs more model calls than one answer may make (AI_CHAT_MAX_STEPS, chart ai.chat.maxSteps) ends in
an answer: the last call may call no tool and answers from what was read. On a Claude subscription Claude Code stops at its
own limit and one call without tools answers. The calls before the last are what they were before the setting
(fixtures/chat_requests_two_steps.json, recorded from the code before it)."""
import io
import json
import logging
import os
from types import SimpleNamespace

import pytest

from app.services import claude_code
from app.services.ai import chat_steps, debug_dump, streaming
from app.services.ai.language import build_language_directive
from tests.test_anthropic_messages import FakeAnthropic, assert_goes_on_without_calls, client_for, log_call, said
from tests.test_claude_code import ProcessError, ResultMessage, on, slots_db  # noqa: F401  (fixtures)
from tests.test_tool_results_json import TOOL

EN, KO = "why does it restart?", "web 파드가 왜 재시작하나요?"
RECORDED = os.path.join(os.path.dirname(__file__), "fixtures", "chat_requests_two_steps.json")


async def ask(monkeypatch, client, provider="openai", question=EN):
    """One chat turn as the chats run it, each tool answering "log of <pod>": what was streamed, the saved answer and the
    turn's ai.chat.complete."""
    saved, audits, ran = [], [], []

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            saved.append({"role": role, "content": content, **kw})

        async def get_messages(self, sid):
            return [SimpleNamespace(role="user", content=question)]

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            pass

        async def update_session_title(self, sid, title):
            pass

    async def get_db_service():
        return DB()

    async def write_audit(**kw):
        audits.append(kw)
        return True

    async def audit_up():
        return True, None

    async def no_budget(*a, **kw):
        return None

    async def same_tools(tools, service):
        return tools

    async def execute(name, args, ctx):
        ran.append(name)
        return f"log of {args.get('pod_name')}"

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", write_audit)
    monkeypatch.setattr("app.services.audit_writer.audit_ready", audit_up)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr("app.services.ai.features.gate_tools", same_tools)
    service = SimpleNamespace(
        model="claude-haiku-5-5", provider=provider, user_role="admin", tier="default", cluster_name="self",
        client=client, tool_contexts={}, tool_server=SimpleNamespace(last_redacted=None),
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=build_language_directive,
        _get_tools_definition=lambda: [TOOL],
        _filter_tools_for_output_preference=lambda tools, message: tools,
        _execute_function_with_context=execute,
    )
    events = [e async for e in streaming.session_chat_stream(
        service, "s1", question, system_prompt_override="You are Kubeast.", audit_actor={"user_id": "u1", "email": "a@b"})]
    assert events[-1] == "data: [DONE]\n\n"
    payloads = [json.loads(e.removeprefix("data: ")) for e in events[:-1] if e.startswith("data: {")]
    return SimpleNamespace(
        payloads=payloads, ran=ran, saved=saved[-1] if saved and saved[-1]["role"] == "assistant" else None,
        content=[p["content"] for p in payloads if "content" in p], errors=[p for p in payloads if "error" in p],
        complete=[a for a in audits if a["action"] == "ai.chat.complete"][-1])


def piece(content=None, call=None, finish_reason=None, usage=None):
    calls = [SimpleNamespace(index=0, id=f"call_{call}", function=SimpleNamespace(
        name="k8s_get_pod_logs", arguments=json.dumps({"pod_name": f"pod-{call}"})))] if call else None
    return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=content, tool_calls=calls), finish_reason=finish_reason)],
                           usage=usage)


class AlwaysCalls:
    """A model that calls a tool while it may, then streams `answer`; it keeps each request as it was sent. `steps`: how many
    requests it calls a tool on (None: every one that offers tools)."""

    def __init__(self, answer=("It restarts: ", "out of memory."), finish_reason="stop", steps=None, refuse=()):
        self.requests, self.answer, self.finish_reason, self.steps = [], answer, finish_reason, steps
        self.refuse = list(refuse)  # the numbers of the requests answered with an error
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    async def create(self, **kw):
        self.requests.append(json.dumps(kw, ensure_ascii=False))
        n = len(self.requests)
        if n in self.refuse:
            raise RuntimeError("400 unknown parameter")
        may_call = bool(kw.get("tools")) and kw.get("tool_choice") != "none" and (self.steps is None or n <= self.steps)
        usage = SimpleNamespace(prompt_tokens=100, completion_tokens=10, total_tokens=110)

        async def chunks():
            if may_call:
                yield piece(f"Reading {n}. ")
                yield piece(call=n, finish_reason="tool_calls", usage=usage)
                return
            for text in self.answer:
                yield piece(text)
            yield piece(finish_reason=self.finish_reason, usage=usage)
        return chunks()

    def sent(self, n):
        return json.loads(self.requests[n - 1])


class AnthropicCalls(FakeAnthropic):
    """The Messages API answering each request with a thinking block and a tool call while the request may call one."""

    def __init__(self, answer):
        super().__init__([])
        self.answer, self.turns = answer, []

    def __call__(self, request):
        body = json.loads(request.content)
        n = len(self.bodies) + 1
        if body.get("tools") and body["tool_choice"]["type"] != "none":
            self.turns.append({"content": [{"type": "thinking", "thinking": f"step {n}", "signature": f"sig-{n}"},
                                           log_call(f"toolu_{n}", f"pod-{n}")], "stop_reason": "tool_use", "usage": {}})
            self.replies.append(self.turns[-1])
        else:
            self.replies.append(said(self.answer))
        return super().__call__(request)


@pytest.mark.parametrize("value,steps", [
    (None, 20), ("", 20), ("20", 20), (" 30 ", 30), ("1", 1), ("100", 100), ("0", 1), ("-5", 1), ("101", 100), ("1e+06", 100),
    ("12.7", 12), ("abc", 20), ("nan", 20), ("inf", 20),
])
def test_the_setting_is_held_to_1_to_100_and_anything_else_is_the_default(monkeypatch, value, steps):
    monkeypatch.delenv("AI_CHAT_MAX_STEPS", raising=False)
    if value is not None:
        monkeypatch.setenv("AI_CHAT_MAX_STEPS", value)
    assert chat_steps.max_steps() == steps


@pytest.mark.parametrize("question,language", [(EN, "English"), (KO, "Korean")], ids=["english", "korean"])
def test_the_last_calls_message_names_the_language_of_the_question(question, language):
    text = chat_steps.final_message(question)
    assert f"Write the answer in {language}, the language of the question." in text
    assert "say plainly what you could not read" in text and text.isascii()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["openai", "azure", "gemini", "ollama", "custom"])
async def test_the_last_call_of_a_chat_answer_offers_no_tool_and_its_text_is_the_answer(monkeypatch, provider):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "3")
    model = AlwaysCalls()
    turn = await ask(monkeypatch, model, provider=provider)
    assert len(model.requests) == 3 and turn.ran == ["k8s_get_pod_logs"] * 2 and not turn.errors
    first, second, last = (model.sent(n) for n in (1, 2, 3))
    assert [r["tool_choice"] for r in (first, second)] == ["auto", "auto"] and first["tools"] == second["tools"] == [TOOL]
    assert "tools" not in last and "tool_choice" not in last
    assert {k: v for k, v in last.items() if k != "messages"} == {
        k: v for k, v in second.items() if k not in ("messages", "tools", "tool_choice")}
    n = len(second["messages"])
    assert last["messages"][:n] == second["messages"] and len(last["messages"]) == n + 3
    assert [m["content"] for m in last["messages"] if m["role"] == "tool"] == ["log of pod-1", "log of pod-2"]
    assert last["messages"][-1] == {"role": "user", "content": chat_steps.final_message(EN)}
    assert turn.content == ["Reading 1. ", "Reading 2. ", "It restarts: ", "out of memory."]  # each piece as it came
    assert turn.saved["content"].endswith("</details>\n\nIt restarts: out of memory.") and len(turn.saved["tool_calls"]) == 2
    assert turn.saved["usage"]["model_calls"] == 3 and turn.saved["usage"]["prompt_tokens"] == 300
    after = turn.complete["after"]
    assert (after["iterations"], after["tool_calls"], after["finish_reason"]) == (3, 2, "stop")
    # the last call's size is counted without the tools it was sent without
    assert after["prompt_chars"] == sum(len(json.dumps(r["messages"], ensure_ascii=False)) for r in (first, second, last)) + 2 * len(
        json.dumps([TOOL], ensure_ascii=False))


@pytest.mark.asyncio
@pytest.mark.parametrize("steps", [2, 3, 12])
async def test_on_anthropic_the_last_call_keeps_the_tools_and_may_call_none(monkeypatch, steps):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", str(steps))
    fake = AnthropicCalls("It restarts: out of memory.")
    turn = await ask(monkeypatch, client_for(fake, "claude-haiku-5-5"), provider="anthropic")
    assert len(fake.bodies) == steps and len(turn.ran) == steps - 1 and not turn.errors
    assert_goes_on_without_calls(fake.bodies[-1], fake.bodies[-2], fake.turns)
    results = [b for m in fake.bodies[-1]["messages"] for b in m["content"] if b["type"] == "tool_result"]
    assert [b["content"] for b in results] == [f"log of pod-{n}" for n in range(1, steps)]
    assert fake.bodies[-1]["messages"][-1]["content"][-1] == {"type": "text", "text": chat_steps.final_message(EN)}
    assert "".join(turn.content) == "It restarts: out of memory." and turn.saved["content"].endswith("It restarts: out of memory.")


@pytest.mark.asyncio
async def test_the_default_gives_20_calls(monkeypatch):
    monkeypatch.delenv("AI_CHAT_MAX_STEPS", raising=False)
    model = AlwaysCalls()
    turn = await ask(monkeypatch, model)
    assert len(model.requests) == 20 and turn.ran == ["k8s_get_pod_logs"] * 19 and turn.saved["content"].endswith("out of memory.")


@pytest.mark.asyncio
async def test_with_a_limit_of_one_the_only_call_offers_no_tool(monkeypatch):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "1")
    model = AlwaysCalls()
    turn = await ask(monkeypatch, model)
    assert len(model.requests) == 1 and "tools" not in model.sent(1) and turn.saved["content"] == "It restarts: out of memory."


async def two_step_requests(monkeypatch):
    """What a chat turn that calls a tool once and answers sends: an OpenAI model's arguments, the Messages API's bodies."""
    model = AlwaysCalls(steps=1)
    await ask(monkeypatch, model)

    class Wire(AnthropicCalls):
        sent = []

        def __call__(self, request):
            self.sent.append(request.content.decode())
            return super().__call__(request) if len(self.sent) == 1 else self.answers(request)

        def answers(self, request):
            self.replies.append(said(self.answer))
            return FakeAnthropic.__call__(self, request)

    wire = Wire("It restarts.")
    await ask(monkeypatch, client_for(wire, "claude-haiku-5-5"), provider="anthropic")
    return {"openai": model.requests, "anthropic": wire.sent}


@pytest.mark.asyncio
async def test_an_answer_before_the_last_call_sends_what_it_sent_before_the_setting(monkeypatch):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "3")
    with open(RECORDED, encoding="utf-8") as f:
        assert await two_step_requests(monkeypatch) == json.load(f)  # the same text, byte for byte


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["openai", "anthropic"])
async def test_a_last_call_sent_again_still_calls_no_tool(monkeypatch, provider):
    """A refused request is sent again without stream_options, as the calls before it are without tool_choice."""
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "2")
    model = AlwaysCalls(refuse=[2])
    turn = await ask(monkeypatch, model, provider=provider)
    tools = {"tools": [TOOL], "tool_choice": "none"} if provider == "anthropic" else {}
    for sent in (model.sent(2), model.sent(3)):
        assert {k: sent[k] for k in ("tools", "tool_choice") if k in sent} == tools
    assert "stream_options" in model.sent(2) and "stream_options" not in model.sent(3)
    assert len(turn.ran) == 1 and turn.saved["content"].endswith("out of memory.") and not turn.errors


@pytest.mark.asyncio
async def test_a_tool_the_last_call_asks_for_anyway_is_not_run(monkeypatch):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "2")

    class CallsAnyway(AlwaysCalls):
        async def create(self, **kw):
            await super().create(**kw)

            async def chunks():
                yield piece("Partly read. ")
                yield piece(call=len(self.requests), finish_reason="tool_calls")
            return chunks()

    turn = await ask(monkeypatch, CallsAnyway())
    assert turn.ran == ["k8s_get_pod_logs"] and len(turn.saved["tool_calls"]) == 1
    assert turn.saved["content"].endswith("</details>\n\nPartly read.") and "maxSteps" not in turn.saved["content"]


@pytest.mark.asyncio
async def test_a_last_answer_cut_at_its_length_goes_on(monkeypatch):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "2")

    class Cut(AlwaysCalls):
        async def create(self, **kw):
            if len(self.requests) == 1:
                self.answer, self.finish_reason = ("It restarts: ",), "length"
            else:
                self.answer, self.finish_reason = ("out of memory.",), "stop"
            return await super().create(**kw)

    model = Cut()
    turn = await ask(monkeypatch, model)
    assert len(model.requests) == 3 and turn.saved["content"].endswith("</details>\n\nIt restarts: out of memory.")
    assert "tools" not in model.sent(3) and model.sent(3)["messages"][-2] == {"role": "assistant", "content": "It restarts: "}


@pytest.mark.asyncio
@pytest.mark.parametrize("question", [EN, KO], ids=["english", "korean"])
async def test_a_cut_answer_is_told_to_go_on_in_its_own_language(monkeypatch, question):
    monkeypatch.delenv("AI_CHAT_MAX_STEPS", raising=False)

    class Cut(AlwaysCalls):
        async def create(self, **kw):
            self.finish_reason = "length" if len(self.requests) < 3 else "stop"
            return await super().create(**kw)

    model = Cut(steps=1)
    await ask(monkeypatch, model, question=question)
    assert len(model.requests) == 4  # the call with a tool, the cut answer, a cut rest of it, its end
    for n, told in ((3, 1), (4, 2)):
        users = [m["content"] for m in model.sent(n)["messages"] if m["role"] == "user"]
        assert users == [question] + [
            "Your last answer stopped at its length limit. Go on from right after where it stopped, in the language of "
            "that answer, and do not repeat what it already says."] * told


ENGLISH = ("The model used all the calls one answer may make and wrote no answer. Ask something narrower, or ask an "
           "administrator to raise {}.")
KOREAN = ("모델이 한 답변에 쓸 수 있는 호출을 모두 쓰고도 답을 쓰지 못했습니다. 질문을 더 좁혀 다시 묻거나, "
          "관리자에게 {} 값을 올려 달라고 요청하세요.")


@pytest.mark.asyncio
@pytest.mark.parametrize("question,sentence", [(EN, ENGLISH), (KO, KOREAN)], ids=["english", "korean"])
@pytest.mark.parametrize("answer", [(), ("\n",)], ids=["no text", "a blank line"])
async def test_no_text_from_the_last_call_is_said_in_the_language_of_the_question(monkeypatch, question, sentence, answer):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "2")
    out = next(h for h in debug_dump.log.handlers if isinstance(h, logging.StreamHandler))  # kubeast.ai's, which kubectl logs reads
    buf = io.StringIO()
    before = out.setStream(buf)
    try:
        turn = await ask(monkeypatch, AlwaysCalls(answer=answer), question=question)
    finally:
        out.setStream(before)
    said_so = sentence.format("ai.chat.maxSteps")
    assert turn.content[-1] == said_so and turn.saved["content"].endswith("</details>\n\n" + said_so)
    assert "WARNING kubeast.ai the chat's last model call (2, ai.chat.maxSteps) wrote no answer" in buf.getvalue()
    assert question not in buf.getvalue()


@pytest.mark.asyncio
async def test_an_answer_with_no_text_before_the_last_call_says_nothing_of_the_limit(monkeypatch):
    """As before: only the limit has a sentence."""
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "5")
    turn = await ask(monkeypatch, AlwaysCalls(answer=(), steps=1))
    assert turn.content == ["Reading 1. "] and "maxSteps" not in turn.saved["content"]


# --- a Claude subscription ---

USAGE = {"input_tokens": 4, "cache_read_input_tokens": 998, "cache_creation_input_tokens": 1097, "output_tokens": 57}
CUT = ResultMessage(subtype="error_max_turns", is_error=True, num_turns=3, usage=USAGE)
STOPPED = [("text", "Looking."), ("call", "k8s_get_pod_logs", {"pod_name": "pod-1"}),
           ("call", "k8s_get_pod_logs", {"pod_name": "pod-2"}), ("result", CUT)]


class Runs:
    """The fake SDK's script, one for each Claude Code run."""

    def __init__(self, *scripts):
        self.scripts = list(scripts)

    def __iter__(self):
        return iter(self.scripts.pop(0))


def subscription():
    chat = claude_code.ClaudeCodeChat(model="claude-haiku-5-5", token="t")
    return SimpleNamespace(claude_code=chat, chat=chat.chat)


def done(text):
    return ("result", ResultMessage(subtype="success", is_error=False, num_turns=1, result=text, usage=USAGE))


@pytest.mark.asyncio
async def test_a_subscription_turn_stopped_at_its_limit_is_answered_by_one_call_without_tools(on, monkeypatch):  # noqa: F811
    sdk = on(Runs(STOPPED, [("stream", ["It restarts: ", "out of memory."]), done("It restarts: out of memory.")]))
    turn = await ask(monkeypatch, subscription(), provider="claude-code", question=KO)
    (first, options), (closing, closing_options) = sdk.state["options"]
    assert options.max_turns == 10 and options.mcp_servers and not getattr(closing_options, "mcp_servers", None)
    # the question, then in one request what the tools returned and the last call's message; the same system prompt
    assert first == KO and closing_options.system_prompt == options.system_prompt
    assert closing.endswith('Tool results so far:\n\nk8s_get_pod_logs {"pod_name": "pod-1"}\nlog of pod-1\n\n'
                            'k8s_get_pod_logs {"pod_name": "pod-2"}\nlog of pod-2\n\n' + chat_steps.final_message(KO))
    assert "User: " + KO in closing
    assert turn.content == ["Looking.", "It restarts: ", "out of memory."] and not turn.errors
    assert turn.ran == ["k8s_get_pod_logs"] * 2
    assert turn.saved["content"].startswith("Looking.\n\n<details>") and turn.saved["content"].endswith("</details>\n\nIt restarts: out of memory.")
    assert turn.saved["content"].count("It restarts: out of memory.") == 1
    # two model responses of the first run, then the closing call; both runs' tokens
    assert turn.saved["usage"]["model_calls"] == 3 and turn.saved["usage"]["prompt_tokens"] == 2 * 2099
    assert turn.saved["usage"]["completion_tokens"] == 2 * 57
    after = turn.complete["after"]
    assert (after["iterations"], after["tool_calls"], after["finish_reason"]) == (3, 2, "max_turns")


@pytest.mark.asyncio
@pytest.mark.parametrize("question,sentence", [(EN, ENGLISH), (KO, KOREAN)], ids=["english", "korean"])
async def test_a_subscriptions_empty_closing_call_names_its_own_setting(on, monkeypatch, question, sentence):  # noqa: F811
    sdk = on(Runs(STOPPED, [done("")]))
    turn = await ask(monkeypatch, subscription(), provider="claude-code", question=question)
    said_so = sentence.format("ai.providers.claudeCode.maxTurns")
    assert len(sdk.state["options"]) == 2 and turn.content == ["Looking.", said_so]
    assert turn.saved["content"].endswith("</details>\n\n" + said_so) and turn.saved["content"].count(said_so) == 1


@pytest.mark.asyncio
async def test_a_subscriptions_closing_call_that_fails_keeps_what_was_read(on, monkeypatch):  # noqa: F811
    on(Runs(STOPPED, [("stream", ["It restarts"]), ("raise", ProcessError("Command failed with exit code 1"))]))
    turn = await ask(monkeypatch, subscription(), provider="claude-code")
    assert len(turn.errors) == 1 and turn.complete["result"] == "failure"
    assert turn.saved["usage"]["failed"] is True and len(turn.saved["tool_calls"]) == 2
    assert turn.saved["content"].startswith("Looking.\n\n<details>") and turn.saved["content"].endswith("It restarts")


@pytest.mark.asyncio
async def test_a_subscription_turn_that_ends_by_itself_makes_no_closing_call(on, monkeypatch):  # noqa: F811
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "1")  # an API key's limit
    sdk = on(Runs([("call", "k8s_get_pod_logs", {"pod_name": "pod-1"}), ("text", "It restarts."), done("It restarts.")]))
    turn = await ask(monkeypatch, subscription(), provider="claude-code")
    assert len(sdk.state["options"]) == 1 and turn.content == ["It restarts."] and turn.complete["after"]["finish_reason"] == "stop"
    assert turn.saved["content"].count("It restarts.") == 1
