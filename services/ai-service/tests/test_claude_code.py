"""Provider claude-code (app/services/claude_code.py): a Claude subscription's setup-token through Claude Code.

The Claude Agent SDK is not installed in tests: a fake module stands in for it. Its query() plays a script —
assistant text, a tool call answered by the handler the provider registered (as Claude Code would ask the
in-process tool server), and the result — and records the options it was given.
"""
import asyncio
import json
import os
import sys
import types
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Optional

import pytest
from fastapi import HTTPException

from app.services import claude_code, model_config_policy


@dataclass
class TextBlock:
    text: str


@dataclass
class AssistantMessage:
    content: list
    model: str = "claude-haiku-5-5"


@dataclass
class ResultMessage:
    subtype: str
    is_error: bool
    num_turns: int
    result: Optional[str] = None
    usage: Optional[dict] = None
    errors: Optional[list] = None
    api_error_status: Optional[int] = None


class ProcessError(Exception):
    pass


def make_sdk(script, *, record=None):
    """A stand-in claude_agent_sdk. `script` items: ("text", str) | ("call", tool, args) | ("result", ResultMessage)
    | ("raise", Exception) | ("sleep", seconds)."""
    sdk = types.ModuleType("claude_agent_sdk")
    sdk.TextBlock, sdk.AssistantMessage, sdk.ResultMessage = TextBlock, AssistantMessage, ResultMessage
    state = {"options": [], "running": 0, "max_running": 0, "tool_results": []}

    class ClaudeAgentOptions:
        def __init__(self, **kw):
            self.__dict__.update(kw)

    def tool(name, description, schema):
        def deco(fn):
            return SimpleNamespace(name=name, description=description, input_schema=schema, handler=fn)
        return deco

    def create_sdk_mcp_server(name, version, tools):
        return {"type": "sdk", "name": name, "tools": {t.name: t for t in tools}}

    async def query(*, prompt, options):
        state["options"].append((prompt, options))
        state["cwd_existed"] = os.path.isdir(options.cwd)
        state["running"] += 1
        state["max_running"] = max(state["max_running"], state["running"])
        try:
            for step in script:
                kind = step[0]
                if kind == "text":
                    yield AssistantMessage(content=[TextBlock(step[1])])
                elif kind == "call":
                    server = options.mcp_servers[claude_code.TOOL_SERVER]
                    answer = await server["tools"][step[1]].handler(step[2])
                    state["tool_results"].append(answer)
                elif kind == "result":
                    yield step[1]
                elif kind == "raise":
                    raise step[1]
                elif kind == "sleep":
                    await asyncio.sleep(step[1])
        finally:
            state["running"] -= 1

    sdk.ClaudeAgentOptions, sdk.tool, sdk.create_sdk_mcp_server, sdk.query = ClaudeAgentOptions, tool, create_sdk_mcp_server, query
    sdk.state = state
    return sdk


USAGE = {"input_tokens": 4, "cache_read_input_tokens": 998, "cache_creation_input_tokens": 1097, "output_tokens": 57}
OK = ResultMessage(subtype="success", is_error=False, num_turns=2, result="You can use 2 clusters.", usage=USAGE)
TOOLS = [
    {"type": "function", "function": {"name": "list_clusters", "description": "List clusters", "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "k8s_get_resources", "description": "Get", "parameters": {"type": "object"}}},
]


@pytest.fixture
def on(monkeypatch):
    """The provider switched on, with a fresh concurrency limit."""
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_ENABLED", True, raising=False)
    monkeypatch.setattr(claude_code, "_semaphore", None)

    def install(script):
        sdk = make_sdk(script)
        monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
        return sdk
    return install


def sse(events):
    return [json.loads(e.removeprefix("data: ").strip()) for e in events]


def test_unavailable_until_switched_on_and_installed(monkeypatch):
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_ENABLED", False, raising=False)
    assert "ai.providers.claudeCode.enabled" in claude_code.unavailable_reason()
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_ENABLED", True, raising=False)
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)  # import fails as in an image built without it
    assert "WITH_CLAUDE_CODE=true" in claude_code.unavailable_reason()
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", make_sdk([]))
    assert claude_code.unavailable_reason() is None


def test_the_child_environment_carries_only_the_token(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api-key-of-this-service")
    monkeypatch.setenv("DATABASE_URL", "postgres://kubeast:pw@db/kubeast")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy:3128")
    env = claude_code.child_env("sk-ant-oat01-token", str(tmp_path))
    assert env["ANTHROPIC_API_KEY"] == "" and env["DATABASE_URL"] == ""  # blanked over the inherited values
    assert "HTTPS_PROXY" not in env and "PATH" not in env  # kept: the SDK passes the inherited value through
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat01-token"
    assert env["HOME"] == env["CLAUDE_CONFIG_DIR"] == str(tmp_path)
    assert env["ENABLE_TOOL_SEARCH"] == "false" and env["DISABLE_AUTOUPDATER"] == "1"


def test_custom_cas_become_one_extra_ca_file(monkeypatch, tmp_path):
    from app.services import tls
    cas = tmp_path / "cas"
    cas.mkdir()
    (cas / "a.crt").write_text("-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n")
    (cas / "b.crt").write_text("-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----")
    given = tmp_path / "given.pem"
    given.write_text("-----BEGIN CERTIFICATE-----\nG\n-----END CERTIFICATE-----\n")
    monkeypatch.setenv("CUSTOM_CA_DIR", str(cas))
    monkeypatch.setenv("NODE_EXTRA_CA_CERTS", str(given))
    tls._custom_ca_files.cache_clear()
    work = tmp_path / "work"
    work.mkdir()
    try:
        env = claude_code.child_env("t", str(work))
    finally:
        tls._custom_ca_files.cache_clear()
    bundle = open(env["NODE_EXTRA_CA_CERTS"]).read()
    assert bundle.count("BEGIN CERTIFICATE") == 3 and bundle.index("\nG\n") < bundle.index("\nA\n") < bundle.index("\nB\n")


def test_messages_become_a_system_prompt_and_a_transcript():
    system, prompt = claude_code.split_messages([
        {"role": "system", "content": "rules"},
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "answer"},
        {"role": "system", "content": "language"},
        {"role": "user", "content": "second"},
    ])
    assert system == "rules\n\nlanguage"
    assert prompt == "Conversation so far:\n<<<\nUser: first\n\nAssistant: answer\n>>>\n\nCurrent request:\nsecond"
    assert claude_code.split_messages([{"role": "user", "content": "only"}]) == ("", "only")


def test_tool_parameters_get_the_shape_the_sdk_needs():
    assert claude_code.tool_schema({"type": "object"}) == {"type": "object", "properties": {}}
    assert claude_code.tool_schema(None) == {"type": "object", "properties": {}}
    full = {"type": "object", "properties": {"ns": {"type": "string"}}, "required": ["ns"]}
    assert claude_code.tool_schema(full) == full


@pytest.mark.asyncio
async def test_a_chat_turn_runs_the_tools_here_and_streams_like_the_api_key_path(on):
    sdk = on([("text", "Checking."), ("call", "list_clusters", {}), ("text", "You can use 2 clusters."), ("result", OK)])
    calls = []

    async def run_tool(name, args, turn):
        calls.append((name, args, turn))
        return [f"data: {json.dumps({'function_result': name, 'result': '[self, default]'})}\n\n"], '["self","default"]'

    chat = claude_code.ClaudeCodeChat(model="claude-haiku-5-5", token="sk-ant-oat01-token")
    out = claude_code.TurnResult()
    events = sse([e async for e in chat.turn(messages=[{"role": "system", "content": "sys"}, {"role": "user", "content": "how many?"}],
                                            tools=TOOLS, run_tool=run_tool, out=out)])

    assert events == [
        {"content": "Checking."},
        {"function": "list_clusters", "args": {}},
        {"function_result": "list_clusters", "result": "[self, default]"},
        {"content": "\n\nYou can use 2 clusters."},
    ]
    assert calls == [("list_clusters", {}, 1)]
    assert sdk.state["tool_results"] == [{"content": [{"type": "text", "text": '["self","default"]'}]}]
    assert out.text == "You can use 2 clusters." and out.tool_calls == 1 and out.turns == 2 and out.finish_reason == "stop"
    assert out.usage == {"prompt_tokens": 2099, "completion_tokens": 57, "total_tokens": 2156,
                         "prompt_tokens_details": {"cached_tokens": 998}, "cache_creation_input_tokens": 1097}
    prompt, opts = sdk.state["options"][0]
    assert prompt == "how many?" and opts.system_prompt == "sys" and opts.model == "claude-haiku-5-5"
    assert opts.tools == [] and opts.setting_sources == [] and opts.strict_mcp_config is True
    assert opts.allowed_tools == ["mcp__kubeast__list_clusters", "mcp__kubeast__k8s_get_resources"]
    assert opts.max_turns == 10 and opts.env["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat01-token"
    assert sdk.state["cwd_existed"] and not os.path.exists(opts.cwd)  # a temporary directory, gone afterwards
    assert opts.mcp_servers["kubeast"]["tools"]["k8s_get_resources"].input_schema == {"type": "object", "properties": {}}


@pytest.mark.asyncio
async def test_without_a_result_text_the_answer_is_what_follows_the_last_tool_call(on):
    on([("text", "Checking."), ("call", "list_clusters", {}), ("text", "Two clusters."), ("text", "self and default."),
        ("result", ResultMessage(subtype="success", is_error=False, num_turns=2, result=None, usage=USAGE))])

    async def run_tool(name, args, turn):
        return [], "[]"

    out = claude_code.TurnResult()
    [e async for e in claude_code.ClaudeCodeChat(model="m", token="t").turn(
        messages=[{"role": "user", "content": "x"}], tools=TOOLS, run_tool=run_tool, out=out)]
    assert out.text == "Two clusters.\n\nself and default."


@pytest.mark.asyncio
async def test_an_error_result_raises_with_its_status_and_masked(on):
    leaked = "sk-ant-oat01-" + "Zx9" * 20
    on([("result", ResultMessage(subtype="success", is_error=True, num_turns=1, result=f"Invalid bearer token {leaked}",
                                 api_error_status=401)), ("raise", ProcessError("Command failed with exit code 1"))])
    chat = claude_code.ClaudeCodeChat(model="m", token="t")
    with pytest.raises(claude_code.ClaudeCodeError) as err:
        async for _ in chat.turn(messages=[{"role": "user", "content": "hi"}], tools=[], run_tool=None, out=claude_code.TurnResult()):
            pass
    assert "(HTTP 401)" in str(err.value) and "Invalid bearer token" in str(err.value) and leaked not in str(err.value)


@pytest.mark.asyncio
async def test_a_failure_without_a_result_reports_the_error(on):
    on([("raise", ProcessError("Command failed with exit code 1"))])
    with pytest.raises(claude_code.ClaudeCodeError, match="exit code 1"):
        await claude_code.complete([{"role": "user", "content": "hi"}], model="m", token="t")


@pytest.mark.asyncio
async def test_max_turns_ends_the_turn_without_an_answer(on):
    on([("call", "list_clusters", {}), ("result", ResultMessage(subtype="error_max_turns", is_error=True, num_turns=10))])

    async def run_tool(name, args, turn):
        return [], "[]"

    out = claude_code.TurnResult()
    [e async for e in claude_code.ClaudeCodeChat(model="m", token="t").turn(
        messages=[{"role": "user", "content": "x"}], tools=TOOLS, run_tool=run_tool, out=out)]
    assert out.finish_reason == "max_turns" and out.text == "" and out.turns == 10


@pytest.mark.asyncio
async def test_a_run_past_the_turn_timeout_is_stopped(on, monkeypatch):
    sdk = on([("sleep", 5), ("result", OK)])
    monkeypatch.setattr(claude_code, "turn_timeout", lambda: 0.05)
    with pytest.raises(claude_code.ClaudeCodeError, match="did not finish"):
        await claude_code.complete([{"role": "user", "content": "x"}], model="m", token="t")
    assert sdk.state["running"] == 0  # the query was closed


@pytest.mark.asyncio
async def test_runs_wait_for_the_concurrency_limit(on):
    sdk = on([("sleep", 0.05), ("result", OK)])
    await asyncio.gather(*(claude_code.complete([{"role": "user", "content": "x"}], model="m", token="t") for _ in range(3)))
    assert sdk.state["max_running"] == 1 and len(sdk.state["options"]) == 3


@pytest.mark.asyncio
async def test_leaving_a_turn_early_stops_the_run(on):
    sdk = on([("text", "first"), ("sleep", 5), ("result", OK)])
    gen = claude_code.ClaudeCodeChat(model="m", token="t").turn(
        messages=[{"role": "user", "content": "x"}], tools=[], run_tool=None, out=claude_code.TurnResult())
    assert sse([await gen.__anext__()]) == [{"content": "first"}]
    await gen.aclose()  # the user pressed stop
    for _ in range(20):
        if sdk.state["running"] == 0:
            break
        await asyncio.sleep(0.01)
    assert sdk.state["running"] == 0


@pytest.mark.asyncio
async def test_plain_completions_answer_as_chat_completions(on):
    on([("result", ResultMessage(subtype="success", is_error=False, num_turns=1, result="ok", usage=USAGE))])
    completions = claude_code.ClaudeCodeChat(model="m", token="t").chat.completions
    resp = await completions.create(messages=[{"role": "user", "content": "x"}], temperature=0.2)
    assert resp.choices[0].message.content == "ok" and resp.usage.prompt_tokens == 2099
    assert resp.usage.prompt_tokens_details.cached_tokens == 998

    stream = await completions.create(messages=[{"role": "user", "content": "x"}], stream=True)
    chunks = [c async for c in stream]
    assert chunks[0].choices[0].delta.content == "ok" and chunks[1].choices[0].finish_reason == "stop"
    assert chunks[2].choices == [] and chunks[2].usage.completion_tokens == 57

    with pytest.raises(claude_code.ClaudeCodeError, match="only in the AI chat"):
        await completions.create(messages=[{"role": "user", "content": "x"}], tools=TOOLS)


@pytest.mark.asyncio
async def test_the_connection_test_reports_success_or_the_reason(on, monkeypatch):
    on([("result", ResultMessage(subtype="success", is_error=False, num_turns=1, result="ok"))])
    assert (await claude_code.test_connection("m", "t"))["success"] is True
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_ENABLED", False, raising=False)
    res = await claude_code.test_connection("m", "t")
    assert res["success"] is False and "ai.providers.claudeCode.enabled" in res["message"]


def test_the_subscription_token_goes_only_to_claude_code():
    check = model_config_policy.check_provider_fields
    model_config_policy.check_api_key_env("CLAUDE_CODE_OAUTH_TOKEN")
    check("claude-code", ["CLAUDE_CODE_OAUTH_TOKEN"], "")
    check("claude-code", ["KUBEAST_AI_KEY_CLAUDE_SUB"], None)
    check("openai", ["OPENAI_API_KEY"], "https://api.openai.com/v1")
    for provider, envs, base, words in [
        ("openai", ["CLAUDE_CODE_OAUTH_TOKEN"], "", "only provider claude-code"),
        ("anthropic", [None, "CLAUDE_CODE_OAUTH_TOKEN"], "", "only provider claude-code"),
        ("claude-code", ["ANTHROPIC_API_KEY"], "", "not ANTHROPIC_API_KEY"),
        ("claude-code", ["CLAUDE_CODE_OAUTH_TOKEN"], "https://evil.example.com", "takes no base_url"),
    ]:
        with pytest.raises(model_config_policy.PolicyError, match=words):
            check(provider, envs, base)


def test_a_subscription_config_never_borrows_the_openai_key(monkeypatch):
    from app.services import model_config_service
    monkeypatch.setattr(model_config_service.settings, "OPENAI_API_KEY", "sk-openai-fallback-key-0000")
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    row = SimpleNamespace(id=1, provider="claude-code", model="claude-sonnet-5-5", base_url=None, api_key_env="CLAUDE_CODE_OAUTH_TOKEN",
                          api_key_secret_key=None, extra_headers={}, tls_verify=True)
    with pytest.raises(ValueError, match="API key is missing"):
        model_config_service._build_resolved(row)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-" + "a" * 40)
    resolved = model_config_service._build_resolved(row)
    assert resolved.api_key.startswith("sk-ant-oat01-") and resolved.provider == "claude-code"


def test_saving_a_subscription_config_needs_the_provider_on(monkeypatch):
    from app import api
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_ENABLED", False, raising=False)
    data = {"name": "mine", "provider": "claude-code", "model": "claude-sonnet-5-5", "api_key_env": "CLAUDE_CODE_OAUTH_TOKEN"}
    with pytest.raises(HTTPException) as err:
        api._check_model_config_policy(data)
    assert err.value.status_code == 400 and "ai.providers.claudeCode.enabled" in err.value.detail
    # an existing subscription config can still be edited (or switched off) while the provider is off
    api._check_model_config_policy({"enabled": False, "provider": "claude-code"}, SimpleNamespace(provider="claude-code", api_key_env="CLAUDE_CODE_OAUTH_TOKEN", api_key_secret_key=None, base_url=None))
    # another provider may not take the token, also when only the variable changes
    with pytest.raises(HTTPException, match="only provider claude-code"):
        api._check_model_config_policy({"api_key_env": "CLAUDE_CODE_OAUTH_TOKEN"}, SimpleNamespace(provider="openai", api_key_env="OPENAI_API_KEY", api_key_secret_key=None, base_url=None))


@pytest.mark.asyncio
async def test_the_connection_test_route_says_why_before_reading_the_variable(monkeypatch):
    from app import api_public
    monkeypatch.setattr(claude_code.settings, "AI_CLAUDE_CODE_ENABLED", False, raising=False)
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    res = await api_public.test_model_connection({"provider": "claude-code", "model": "claude-sonnet-5-5", "api_key_env": "CLAUDE_CODE_OAUTH_TOKEN"})
    assert res["success"] is False and "ai.providers.claudeCode.enabled" in res["message"]
    listed = await api_public.list_provider_models({"provider": "claude-code", "api_key_env": "CLAUDE_CODE_OAUTH_TOKEN"})
    assert listed["models"] == [] and "no model list" in listed["error"]


@pytest.mark.asyncio
async def test_a_session_turn_through_claude_code_is_saved_and_audited_like_any_other(on, monkeypatch):
    from app.services.ai import streaming

    sdk = on([("text", "Checking."), ("call", "list_clusters", {}), ("text", "You can use 2 clusters."), ("result", OK)])
    saved, audits = [], []

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            saved.append({"role": role, "content": content, **kw})

        async def get_messages(self, sid):
            return [SimpleNamespace(role="user", content="how many clusters?")]

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            pass

        async def update_session_title(self, sid, title):
            pass

    async def get_db_service():
        return DB()

    async def fake_write_audit(**kw):
        audits.append(kw)
        return True

    async def no_budget(*a, **kw):
        return None

    async def same_tools(tools, service):
        return tools

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", fake_write_audit)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr("app.services.ai.features.gate_tools", same_tools)

    executed = []

    async def execute(name, args, ctx):
        executed.append(name)
        return json.dumps([{"name": "self"}, {"name": "default"}])

    from app.services.ai_service import ToolContext  # noqa: F401  (imported by the stream)
    service = SimpleNamespace(
        model="claude-haiku-5-5", provider="claude-code", user_role="read", tier="default", cluster_name="self",
        client=SimpleNamespace(claude_code=claude_code.ClaudeCodeChat(model="claude-haiku-5-5", token="t")),
        tool_contexts={}, tool_server=SimpleNamespace(last_redacted=None),
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=lambda message: "Answer in English.",
        _get_tools_definition=lambda: TOOLS,
        _filter_tools_for_output_preference=lambda tools, message: tools,
        _detect_write_intent=lambda message: False,
        _execute_function_with_context=execute,
    )

    events = [e async for e in streaming.session_chat_stream(
        service, "s1", "how many clusters?", audit_actor={"user_id": "u1", "email": "a@b"}, audit_http={"ip": "10.0.0.1"})]

    assert executed == ["list_clusters"]  # the chat's own tool code ran the call
    payloads = [json.loads(e.removeprefix("data: ").strip()) for e in events if e != "data: [DONE]\n\n"]
    assert payloads[0]["model_info"]["provider"] == "claude-code"
    assert [p.get("function") for p in payloads if "function" in p] == ["list_clusters"]
    assert any(p.get("function_result") == "list_clusters" for p in payloads)
    assert events[-1] == "data: [DONE]\n\n"
    answer = saved[-1]
    assert answer["role"] == "assistant" and answer["content"].endswith("You can use 2 clusters.")
    assert "<strong>list_clusters</strong>" in answer["content"]  # tool details as with an API key
    assert answer["tool_calls"][0]["function"] == "list_clusters"
    assert answer["usage"] == {"prompt_tokens": 2099, "completion_tokens": 57, "cached_tokens": 998, "model_calls": 2, "model": "claude-haiku-5-5"}
    actions = [a["action"] for a in audits]
    assert actions == ["ai.chat.send", "ai.tool.call", "ai.chat.complete"]
    complete = audits[-1]["after"]
    assert complete["provider"] == "claude-code" and complete["tool_calls"] == 1 and complete["iterations"] == 2
    assert sdk.state["options"][0][1].system_prompt.endswith("Answer in English.")
