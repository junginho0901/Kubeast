"""A chat question that needs more model calls than one answer may make (AI_CHAT_MAX_STEPS, chart ai.chat.maxSteps) ends in
an answer: the last call may call no tool and answers from what was read. On a Claude subscription Claude Code stops at its
own limit and one call without tools answers. The calls before the last are what they were before the setting
(fixtures/chat_requests_two_steps.json, recorded from the code before it)."""
import asyncio
import io
import json
import logging
import os
from types import SimpleNamespace

import pytest

from app.services import claude_code, claude_code_slots
from app.services.ai import chat_steps, debug_dump, streaming
from app.services.ai.language import build_language_directive
from tests.test_anthropic_messages import FakeAnthropic, assert_goes_on_without_calls, client_for, log_call, said
from tests.test_claude_code import ProcessError, ResultMessage, on, slots_db, until  # noqa: F401  (fixtures)
from tests.test_tool_results_json import TOOL

EN, KO = "why does it restart?", "web 파드가 왜 재시작하나요?"
RECORDED = os.path.join(os.path.dirname(__file__), "fixtures", "chat_requests_two_steps.json")


async def ask(monkeypatch, client, provider="openai", question=EN, tools=(TOOL,)):
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
        _get_tools_definition=lambda: list(tools),
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
@pytest.mark.parametrize("provider", ["openai", "azure", "gemini", "ollama", "custom", "anthropic"])
async def test_a_last_call_sent_again_still_calls_no_tool(monkeypatch, provider):
    """A refused request is sent again without stream_options, as the calls before it are without tool_choice, and with the
    tools and tool_choice none, which on Anthropic the first one has too."""
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "2")
    model = AlwaysCalls(refuse=[2])
    turn = await ask(monkeypatch, model, provider=provider)
    none_called = {"tools": [TOOL], "tool_choice": "none"}
    first, again = ({k: v for k, v in model.sent(n).items() if k != "messages"} for n in (2, 3))
    assert {k: first[k] for k in ("tools", "tool_choice") if k in first} == (none_called if provider == "anthropic" else {})
    assert again == {**{k: v for k, v in first.items() if k != "stream_options"}, **none_called} and "stream_options" in first
    assert model.sent(3)["messages"] == model.sent(2)["messages"]
    assert len(turn.ran) == 1 and turn.saved["content"].endswith("out of memory.") and not turn.errors
    # the answered request's size, with the tools it was sent with
    assert turn.complete["after"]["prompt_chars"] == sum(
        len(json.dumps(model.sent(n)["messages"], ensure_ascii=False)) + len(json.dumps([TOOL], ensure_ascii=False)) for n in (1, 3))


@pytest.mark.asyncio
async def test_a_gateway_that_takes_tool_messages_only_beside_the_tools_answers_the_last_call(monkeypatch):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "3")

    class NeedsTools(AlwaysCalls):
        async def create(self, **kw):
            if not kw.get("tools") and any(m["role"] == "tool" for m in kw["messages"]):
                self.refuse.append(len(self.requests) + 1)
            return await super().create(**kw)

    model = NeedsTools()
    turn = await ask(monkeypatch, model)
    assert ["tools" in model.sent(n) for n in (1, 2, 3, 4)] == [True, True, False, True] and len(model.requests) == 4
    assert not turn.errors and len(turn.ran) == 2 and turn.saved["content"].endswith("</details>\n\nIt restarts: out of memory.")


@pytest.mark.asyncio
async def test_a_call_before_the_last_is_sent_again_as_before(monkeypatch):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "3")
    model = AlwaysCalls(refuse=[1])
    turn = await ask(monkeypatch, model)
    first, again = model.sent(1), model.sent(2)
    assert first["tool_choice"] == "auto" and again == {k: v for k, v in first.items() if k not in ("tool_choice", "stream_options")}
    assert again["tools"] == [TOOL] and not turn.errors


@pytest.mark.asyncio
async def test_a_last_call_with_no_tools_to_offer_is_sent_again_without_them(monkeypatch):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "1")
    model = AlwaysCalls(refuse=[1])
    turn = await ask(monkeypatch, model, tools=())
    assert len(model.requests) == 2 and not {"tools", "tool_choice"} & model.sent(2).keys()
    assert turn.saved["content"] == "It restarts: out of memory."


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


LENGTH = {EN: "The model reached its answer length before it wrote an answer. Ask something narrower, or ask an administrator to "
              "raise the model's answer length (max_tokens).",
          KO: "모델이 답을 쓰기 전에 답 최대 길이에 닿았습니다. 질문을 더 좁혀 다시 묻거나, 관리자에게 이 모델의 답 최대 길이(max_tokens)를 "
              "올려 달라고 요청하세요."}
FILTER = {EN: "The model provider's content filter stopped the answer before any of it came. Ask the question in other words.",
          KO: "모델 공급자의 콘텐츠 필터가 답이 나오기 전에 답을 막았습니다. 다른 말로 다시 질문하세요."}


@pytest.mark.asyncio
@pytest.mark.parametrize("question", [EN, KO], ids=["english", "korean"])
@pytest.mark.parametrize("finish_reason,sentences,requests", [("length", LENGTH, 5), ("content_filter", FILTER, 2)])
async def test_a_last_answer_stopped_before_any_text_says_what_stopped_it(monkeypatch, question, finish_reason, sentences, requests):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "2")
    model = AlwaysCalls(answer=(), finish_reason=finish_reason)
    turn = await ask(monkeypatch, model, question=question)
    said_so = sentences[question]
    assert turn.content == ["Reading 1. ", said_so] and turn.saved["content"].endswith("</details>\n\n" + said_so)
    assert "maxSteps" not in turn.saved["content"] and len(model.requests) == requests  # a cut answer goes on three times
    assert turn.complete["after"]["finish_reason"] == finish_reason and turn.complete["result"] == "success"


@pytest.mark.asyncio
@pytest.mark.parametrize("ends,sentence", [
    (["length", "stop"], ENGLISH.format("ai.chat.maxSteps")), (["length", "content_filter"], FILTER[EN]), (["length", None], LENGTH[EN]),
    ([None], ENGLISH.format("ai.chat.maxSteps")), (["tool_calls"], ENGLISH.format("ai.chat.maxSteps")),
], ids=["length, then stop", "length, then the filter", "length, then nothing", "nothing", "a call"])
async def test_the_last_finish_reason_decides_the_sentence(monkeypatch, ends, sentence):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "2")

    class Ends(AlwaysCalls):
        async def create(self, **kw):
            if self.requests:  # after the call that reads
                self.finish_reason = ends[len(self.requests) - 1]
            return await super().create(**kw)

    model = Ends(answer=())
    turn = await ask(monkeypatch, model)
    assert len(model.requests) == 1 + len(ends) and turn.content == ["Reading 1. ", sentence]


@pytest.mark.asyncio
@pytest.mark.parametrize("question", [EN, KO], ids=["english", "korean"])
async def test_an_answer_anthropic_refuses_says_the_filter_stopped_it(monkeypatch, question):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "2")

    class Refuses(AnthropicCalls):
        def __call__(self, request):
            body = json.loads(request.content)
            if body["tool_choice"]["type"] != "none":
                return super().__call__(request)
            self.replies.append({"content": [], "stop_reason": "refusal", "usage": {}})
            return FakeAnthropic.__call__(self, request)

    turn = await ask(monkeypatch, client_for(Refuses(""), "claude-haiku-5-5"), provider="anthropic", question=question)
    assert turn.content == [FILTER[question]] and not turn.errors


@pytest.mark.asyncio
async def test_a_last_answer_the_filter_stopped_part_way_keeps_its_text_alone(monkeypatch):
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "2")
    turn = await ask(monkeypatch, AlwaysCalls(answer=("It restarts: ",), finish_reason="content_filter"))
    assert turn.content == ["Reading 1. ", "It restarts: "] and turn.saved["content"].endswith("</details>\n\nIt restarts:")


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


SLOW = [*STOPPED[:-1], ("sleep", 0.3), STOPPED[-1]]


def one_slot(monkeypatch, *waits):
    """One chat slot, on this server and in the install, and how long each run may wait for it, in the order they ask."""
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_MAX_CONCURRENT", 1, raising=False)
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_MAX_CONCURRENT_TOTAL", 1, raising=False)
    monkeypatch.setattr(claude_code_slots, "POLL_SECONDS", 0.02)
    left = list(waits)
    monkeypatch.setattr(claude_code, "queue_wait", lambda: left.pop(0))


async def next_in_the_queue(sdk):
    """Another question, asked while the turn's first run holds the slot."""
    await until(lambda: sdk.state["running"] == 1)
    return await claude_code.complete([{"role": "user", "content": "another question"}], model="m", token="t")


def kept_what_it_read(turn, said_so):
    """A turn whose closing run never started: a success with the first run's reads, ending in `said_so`."""
    assert turn.content == ["Looking.", said_so] and not turn.errors
    assert turn.saved["content"].startswith("Looking.\n\n<details>") and turn.saved["content"].endswith("</details>\n\n" + said_so)
    assert len(turn.saved["tool_calls"]) == 2 and "failed" not in turn.saved["usage"] and turn.saved["usage"]["model_calls"] == 2
    assert turn.complete["result"] == "success" and turn.complete["error"] is None
    assert (turn.complete["after"]["tool_calls"], turn.complete["after"]["finish_reason"]) == (2, "max_turns")


@pytest.mark.asyncio
@pytest.mark.parametrize("question,sentence", [(EN, ENGLISH), (KO, KOREAN)], ids=["english", "korean"])
async def test_a_closing_run_that_gets_no_slot_in_time_ends_the_turn_with_what_was_read(on, monkeypatch, question, sentence):  # noqa: F811
    one_slot(monkeypatch, 5, 5, 0.1)
    sdk = on(Runs(SLOW, [("hold",), done("the other answer")]))
    other = asyncio.create_task(next_in_the_queue(sdk))
    turn = await ask(monkeypatch, subscription(), provider="claude-code", question=question)
    assert [p["queued"] for p in turn.payloads if "queued" in p] == [True]
    kept_what_it_read(turn, sentence.format("ai.providers.claudeCode.maxTurns"))
    sdk.state["release"].set()
    assert (await other).text == "the other answer" and len(sdk.state["options"]) == 2  # the closing run never started


@pytest.mark.asyncio
async def test_a_closing_run_that_waits_for_its_slot_says_so_and_then_answers(on, monkeypatch):  # noqa: F811
    one_slot(monkeypatch, 5, 5, 5)
    sdk = on(Runs(SLOW, [("sleep", 0.3), done("the other answer")], [("stream", ["It restarts: ", "out of memory."]), done("It restarts: out of memory.")]))
    other = asyncio.create_task(next_in_the_queue(sdk))
    turn = await ask(monkeypatch, subscription(), provider="claude-code")
    said_in_order = [p.get("queued", p.get("content")) for p in turn.payloads if "queued" in p or "content" in p]
    assert said_in_order == ["Looking.", True, False, "It restarts: ", "out of memory."] and not turn.errors
    assert turn.saved["content"].endswith("</details>\n\nIt restarts: out of memory.") and turn.saved["usage"]["model_calls"] == 3
    assert (await other).text == "the other answer" and sdk.state["max_running"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("fails", ["Claude Code ends at once", "it never says anything", "no room for its directory"])
async def test_a_closing_run_that_does_not_start_ends_the_turn_with_what_was_read(on, monkeypatch, fails):  # noqa: F811
    closing = [("sleep", 5)] if fails == "it never says anything" else [("raise", ProcessError("Command failed with exit code 1"))]
    sdk = on(Runs(STOPPED, closing))
    real, asked = claude_code._options, []

    def options(*a, **kw):
        asked.append(kw)
        if len(asked) == 2:
            if fails == "it never says anything":
                monkeypatch.setattr(claude_code, "turn_timeout", lambda: 0.05)
            if fails == "no room for its directory":
                raise OSError(28, "No space left on device")
        return real(*a, **kw)

    monkeypatch.setattr(claude_code, "_options", options)
    turn = await ask(monkeypatch, subscription(), provider="claude-code")
    kept_what_it_read(turn, ENGLISH.format("ai.providers.claudeCode.maxTurns"))
    assert not [p for p in turn.payloads if "queued" in p] and sdk.state["running"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("closing", [
    [("refuse", "rate_limit", 1792407600), ("raise", ProcessError("Command failed with exit code 1"))],
    [("result", ResultMessage(subtype="success", is_error=True, num_turns=1, result="Invalid bearer token", api_error_status=401))],
], ids=["a usage window", "a refused token"])
async def test_a_closing_run_the_provider_refuses_is_an_error(on, monkeypatch, closing):  # noqa: F811
    """It started: what the provider said reaches the page, as in the first run."""
    on(Runs(STOPPED, closing))
    turn = await ask(monkeypatch, subscription(), provider="claude-code")
    assert [p["error_key"] for p in turn.errors] == ["modelUsageWindow" if len(closing) == 2 else "modelAuth"]
    assert turn.complete["result"] == "failure" and turn.saved["usage"]["failed"] is True and len(turn.saved["tool_calls"]) == 2


@pytest.mark.asyncio
async def test_a_first_run_that_gets_no_slot_in_time_is_still_an_error(on, monkeypatch):  # noqa: F811
    one_slot(monkeypatch, 5, 0.05)
    sdk = on(Runs([("hold",), done("the other answer")]))
    other = asyncio.create_task(claude_code.complete([{"role": "user", "content": "another question"}], model="m", token="t"))
    await until(lambda: sdk.state["running"] == 1)
    turn = await ask(monkeypatch, subscription(), provider="claude-code")
    assert [p["error_key"] for p in turn.errors] == ["claudeCodeBusy"] and not turn.content and turn.complete["result"] == "failure"
    sdk.state["release"].set()
    await other


@pytest.mark.asyncio
async def test_a_subscription_turn_that_ends_by_itself_makes_no_closing_call(on, monkeypatch):  # noqa: F811
    monkeypatch.setenv("AI_CHAT_MAX_STEPS", "1")  # an API key's limit
    sdk = on(Runs([("call", "k8s_get_pod_logs", {"pod_name": "pod-1"}), ("text", "It restarts."), done("It restarts.")]))
    turn = await ask(monkeypatch, subscription(), provider="claude-code")
    assert len(sdk.state["options"]) == 1 and turn.content == ["It restarts."] and turn.complete["after"]["finish_reason"] == "stop"
    assert turn.saved["content"].count("It restarts.") == 1
