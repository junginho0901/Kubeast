"""Recorded tool answers (app/services/ai/tool_replay.py): a recording run's answers come back the same in replay, a
call with no recording is an error that reaches no tool-server, off changes nothing, the service does not start in
record or replay without the test install variable, and a recording holds no credential the answer carried. The
calls go through AIService._execute_function_with_context, which the chat, Claude Code and the investigator share."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services import audit_writer
from app.services.ai import streaming, tool_replay
from app.services.ai_service import AIService, ToolContext
from app.services.investigation import runner

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACTOR = {"user_id": "u1", "email": "dev@example.com"}
ANSWER = '{"streams": [{"labels": {"app": "web"}, "lines": ["GET /cart 500 upstream timed out"]}]}'
ARGS = {"logql": '{app="web"} |= "500"', "namespace": "shop", "since": "30m"}
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ"
AWS_KEY = "AKIAIOSFODNN7EXAMPLE"
GH_TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"
PASSWORD = "hunter2-Very-Secret-77"
TOKEN_SHAPES = [re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), re.compile(r"AKIA[0-9A-Z]{16}"),
                re.compile(r"ghp_[A-Za-z0-9]{36}"), re.compile(re.escape(PASSWORD))]


class FakeToolServer:
    def __init__(self, content=ANSWER):
        self.content = content
        self.calls = []
        self.last_redacted = self.last_access = self.last_requests = None

    async def call_tool(self, name, arguments=None, headers=None):
        self.calls.append((name, dict(arguments or {})))
        self.last_access = {"user": "admin", "impersonation": True, "kind": "person", "role": "*"}
        self.last_requests = {"requests": [{"verb": "get", "resource": "pods", "audit_id": "a1"}], "total": 1}
        return self.content


def make_service(content=ANSWER, cluster="self"):
    service = AIService.__new__(AIService)  # the real tool path, without a model client
    service.cluster_name, service.user_role, service._token_payload = cluster, "admin", None
    service.tool_server = FakeToolServer(content)
    service.k8s_service = SimpleNamespace(last_access=None, last_requests=None)
    service.options, service.provider, service.model, service.tool_contexts = {}, "ollama", "m", {}
    return service


@pytest.fixture
def mode(monkeypatch, tmp_path):
    """Set the mode as start() would from the environment; the module's setting is put back after the test."""
    monkeypatch.setattr(tool_replay, "_settings", tool_replay.Settings())

    def set_mode(name, directory=None, test_install="true"):
        env = {tool_replay.MODE_ENV: name, tool_replay.DIR_ENV: str(directory or tmp_path / "rec"),
               tool_replay.TEST_INSTALL_ENV: test_install}
        tool_replay.configure(tool_replay.load(env))
        return Path(env[tool_replay.DIR_ENV])

    return set_mode


async def call(service, tool="loki_query", args=None):
    return await service._execute_function_with_context(tool, dict(ARGS if args is None else args), ToolContext("s1"))


async def test_record_then_replay_gives_the_same_answer(mode):
    directory = mode("record")
    recording = make_service()
    recorded = await call(recording)
    assert recorded == ANSWER and len(recording.tool_server.calls) == 1
    assert len(list(directory.glob("loki_query-*.json"))) == 1

    mode("replay", directory)
    replaying = make_service(content="what the cluster says now")
    replayed = await call(replaying)
    assert replayed == recorded
    assert replaying.tool_server.calls == [], "a replay reads no cluster"
    assert getattr(replaying, tool_replay.OUTCOME_ATTR) == "hit"
    # the same call as the model may write it again: its cluster argument, spaces and empty values do not count
    again = await call(make_service(content="now"), args={**ARGS, "namespace": " shop ", "cluster": "other", "regex": None})
    assert again == recorded


async def test_a_replay_on_another_cluster_or_with_other_arguments_finds_nothing(mode):
    directory = mode("record")
    await call(make_service())
    mode("replay", directory)
    elsewhere = await call(make_service(cluster="default"))
    other_args = await call(make_service(), args={**ARGS, "since": "1h"})
    assert json.loads(elsewhere)["status"] == json.loads(other_args)["status"] == "replay_miss"


async def test_recordings_copied_in_after_the_start_are_found(mode, tmp_path):
    recorded_in = mode("record", tmp_path / "recorded")
    await call(make_service())
    fresh = mode("replay", tmp_path / "fresh-pod" / "rec")  # a new pod's empty /tmp: made, and every call a miss
    assert fresh.is_dir()
    assert json.loads(await call(make_service()))["status"] == "replay_miss"
    for f in recorded_in.glob("*.json"):
        (fresh / f.name).write_text(f.read_text())
    assert await call(make_service(content="now")) == ANSWER


async def test_a_call_with_no_recording_is_an_error_and_reaches_no_tool_server(mode, tmp_path):
    mode("replay", tmp_path / "empty")
    service = make_service()
    answer = json.loads(await call(service))
    assert answer["status"] == "replay_miss" and "No recorded answer" in answer["error"] and "not read" in answer["error"]
    assert service.tool_server.calls == []
    assert getattr(service, tool_replay.OUTCOME_ATTR) == "miss"
    # tool-server is not reached by any other way either: an approved write gets the same refusal
    refused = json.loads(await service._call_tool_server("k8s_scale", {"resource_type": "deployment"}, approval_id="a1"))
    assert refused["status"] == "replay_refused" and service.tool_server.calls == []


async def test_a_write_tool_does_not_run_in_replay_and_is_not_recorded(mode):
    directory = mode("record")
    recording = make_service(content="scaled")
    assert await call(recording, "k8s_scale", {"resource_type": "deployment", "resource_name": "web", "replicas": 2}) == "scaled"
    assert list(directory.glob("*.json")) == []
    mode("replay", directory)
    service = make_service(content="scaled")
    answer = json.loads(await call(service, "k8s_scale", {"resource_type": "deployment", "resource_name": "web", "replicas": 2}))
    assert answer["status"] == "replay_refused" and service.tool_server.calls == []


async def test_off_changes_nothing(mode, tmp_path):
    directory = mode("off", tmp_path / "never")
    service = make_service()
    assert await call(service) == ANSWER
    assert len(service.tool_server.calls) == 1 and not hasattr(service, tool_replay.OUTCOME_ATTR)
    assert not directory.exists(), "off writes no recording and makes no directory"
    assert tool_replay.settings() == tool_replay.Settings() and not tool_replay.serving()
    assert tool_replay.call_fields(service, True) == {} and tool_replay.call_fields(service, False) == {}
    assert tool_replay.load({}) == tool_replay.Settings()


def test_record_and_replay_do_not_start_without_the_test_install_variable(tmp_path):
    for name in ("replay", "record"):
        with pytest.raises(tool_replay.ReplayConfigError, match=tool_replay.TEST_INSTALL_ENV):
            tool_replay.load({tool_replay.MODE_ENV: name, tool_replay.DIR_ENV: str(tmp_path)})
        with pytest.raises(tool_replay.ReplayConfigError, match=tool_replay.TEST_INSTALL_ENV):
            tool_replay.load({tool_replay.MODE_ENV: name, tool_replay.DIR_ENV: str(tmp_path), tool_replay.TEST_INSTALL_ENV: "yes"})
    with pytest.raises(tool_replay.ReplayConfigError, match="off, record or replay"):
        tool_replay.load({tool_replay.MODE_ENV: "on", tool_replay.TEST_INSTALL_ENV: "true"})
    with pytest.raises(tool_replay.ReplayConfigError, match=tool_replay.DIR_ENV):
        tool_replay.load({tool_replay.MODE_ENV: "replay", tool_replay.TEST_INSTALL_ENV: "true"})
    (tmp_path / "file").write_text("")
    with pytest.raises(tool_replay.ReplayConfigError, match="cannot be made"):
        tool_replay.load({tool_replay.MODE_ENV: "replay", tool_replay.DIR_ENV: str(tmp_path / "file" / "rec"),
                          tool_replay.TEST_INSTALL_ENV: "true"})


def _start(env):
    clean = {k: v for k, v in os.environ.items() if not k.startswith("AI_TOOL_REPLAY_")}
    return subprocess.run([sys.executable, "-c", "import main"], cwd=ROOT, capture_output=True, text=True, timeout=120,
                          env={**clean, "MCP_ENABLED": "false", "METRICS_ENABLED": "false", **env})


def test_the_service_start_refuses_replay_without_the_test_install_and_says_when_it_is_on(tmp_path):
    refused = _start({tool_replay.MODE_ENV: "replay", tool_replay.DIR_ENV: str(tmp_path)})
    assert refused.returncode != 0 and tool_replay.TEST_INSTALL_ENV in refused.stderr
    started = _start({tool_replay.MODE_ENV: "replay", tool_replay.DIR_ENV: str(tmp_path), tool_replay.TEST_INSTALL_ENV: "true"})
    assert started.returncode == 0, started.stderr[-2000:]
    assert "AI tool replay: replay" in started.stderr + started.stdout
    quiet = _start({})
    assert quiet.returncode == 0 and "AI tool replay" not in quiet.stderr + quiet.stdout


async def test_a_recording_holds_no_unmasked_token(mode):
    directory = mode("record")
    leaky = (f"level=info msg=connect password={PASSWORD}\nAuthorization: Bearer {JWT}\n"
             f"aws_access_key_id={AWS_KEY}\ntoken: {GH_TOKEN}\n")
    service = make_service(content=leaky)
    answer = await call(service, args={**ARGS, "logql": f'{{app="web"}} |= "{GH_TOKEN}"', "api_key": "sk-test-value-123"})
    written = "".join(p.read_text() for p in directory.glob("*.json"))
    assert written and "<REDACTED" in written
    for shape in TOKEN_SHAPES:
        assert not shape.search(written), shape.pattern
        assert not shape.search(answer), "the recording run gets what a replay will get"
    assert "sk-test-value-123" not in written


def _audit(monkeypatch):
    rows = []

    async def ready():
        return True, None

    async def write(**kw):
        rows.append(kw)
        return True

    monkeypatch.setattr(audit_writer, "audit_ready", ready)
    monkeypatch.setattr(audit_writer, "write_audit", write)
    return rows


async def _chat(service, args=None):
    return await streaming._call_tool(service, None, SimpleNamespace(user_id="u1"), "s1", [], ToolContext("s1"), "loki_query",
                                      dict(ARGS if args is None else args), iteration=1, audit_actor=ACTOR, audit_http=None)


async def test_a_replayed_chat_call_is_audited_as_a_replay(mode, monkeypatch):
    rows = _audit(monkeypatch)
    directory = mode("record")
    await _chat(make_service())
    recorded_row = rows[-1]["after"]
    assert "replay" not in recorded_row and recorded_row["access"] is not None, "a recording run is a real read"

    mode("replay", directory)
    service = make_service()
    events, entry, llm_text = await _chat(service)
    hit = rows[-1]
    assert hit["action"] == "ai.tool.call" and hit["after"]["replay"] is True and hit["after"]["replay_hit"] is True
    assert hit["after"]["access"] is None and hit["after"]["requests"] is None, "no cluster was reached"
    assert hit["result"] == "success" and "upstream timed out" in llm_text
    event = json.loads(events[-1].removeprefix("data: "))
    assert event["replay"] is True and event["replay_hit"] is True and "access" not in event

    await _chat(service, args={**ARGS, "since": "2h"})
    miss = rows[-1]
    assert miss["after"]["replay"] is True and miss["after"]["replay_hit"] is False
    assert miss["result"] == "failure" and "No recorded answer" in miss["error"]
    assert service.tool_server.calls == []


async def test_a_replayed_investigation_call_is_audited_as_a_replay(mode, monkeypatch):
    from app.services.investigation.settings import InvestigationSettings

    directory = mode("record")
    await call(make_service())
    mode("replay", directory)
    service = make_service()
    asked = []

    async def create(**kw):
        asked.append(json.loads(json.dumps(kw["messages"], default=str)))
        if len(asked) == 1:
            fn = SimpleNamespace(name="loki_query", arguments=json.dumps(ARGS))
            msg = SimpleNamespace(content=None, tool_calls=[SimpleNamespace(id="c1", type="function", function=fn)])
        else:
            msg = SimpleNamespace(content="## Summary\nok", tool_calls=None)
        return SimpleNamespace(choices=[SimpleNamespace(message=msg)], usage=None)

    service.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    service._get_tools_definition = lambda: [{"type": "function", "function": {"name": "loki_query"}}]
    rows = []

    async def token(_cfg, _cluster, _namespace):
        return "investigator-token"

    async def build(_cfg, _token, _cluster):
        return service

    async def write(**kw):
        rows.append(kw)
        return True

    async def ready():
        return True, None

    async def gate(tools, _service):
        return tools

    monkeypatch.setattr(runner, "fetch_token", token)
    monkeypatch.setattr(runner, "build_service", build)
    monkeypatch.setattr(runner, "write_audit", write)
    monkeypatch.setattr(runner, "audit_ready", ready)
    monkeypatch.setattr("app.services.ai.features.gate_tools", gate)
    row = SimpleNamespace(id="inv-1", cluster="self", fingerprint="fp", alertname="A", severity="critical", namespace="apps",
                          labels={"alertname": "A"}, annotations={"summary": "s"}, starts_at=None, generator_url="")
    out = await runner.investigate(InvestigationSettings(enabled=True, max_steps=3, timeout_seconds=60), row)

    assert out["tool_calls"][0]["replay"] is True and out["tool_calls"][0]["replay_hit"] is True
    assert rows[-1]["action"] == "ai.tool.call" and rows[-1]["after"]["replay"] is True and rows[-1]["after"]["replay_hit"] is True
    assert "upstream timed out" in json.dumps(asked[-1]) and service.tool_server.calls == []


def test_the_key_is_the_cluster_the_tool_and_the_normalized_arguments():
    base = tool_replay.key("self", "loki_query", ARGS)
    assert base == tool_replay.key("self", "loki_query", {**ARGS, "cluster": "x", "limit": None, "namespace": "shop\n"})
    assert base == tool_replay.key("self", "loki_query", dict(reversed(list(ARGS.items()))))
    assert base != tool_replay.key("default", "loki_query", ARGS)
    assert base != tool_replay.key("self", "logsearch", ARGS)
    assert base != tool_replay.key("self", "loki_query", {**ARGS, "logql": '{app="web"} |= "502"'})
    assert re.fullmatch(r"[0-9a-f]{64}", base)
