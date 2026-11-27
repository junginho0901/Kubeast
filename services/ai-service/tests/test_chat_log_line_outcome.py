"""The outcome of a chat's read of a raw text (a pod's log, a describe, a YAML): what a container or the cluster wrote is the
read's answer, also when it is a JSON object with an `error` or a `status`; only what tool-server or ai-service wrote in
place of it is a refusal, a failure or a status of the ai.tool.call row."""
import json

import pytest

from app.services.ai import repeats, streaming, tool_replay
from tests.test_repeated_reads import ACTOR, _patch_audit, _Service

LOGS = {"namespace": "apps", "pod_name": "web-1"}
LINES = [
    '{"level":"fatal","error":"dial tcp: connection refused"}',
    '{"error": "checked"}',
    '{"status": "forbidden", "path": "/login"}',
    '{"status": "audit_unavailable"}',
    '{"status": "rate_limited", "client": "10.0.0.1"}',
    '{"status": "ok"}',
]


async def _read(service, guard=None, tool="k8s_get_pod_logs", args=LOGS, step=1):
    return await streaming._call_tool(service, None, None, "s1", [], None, tool, dict(args), iteration=step, audit_actor=ACTOR,
                                      audit_http=None, call_id=step - 1, repeats=guard)


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", ["k8s_get_pod_logs", "k8s_describe_resource", "k8s_get_resource_yaml"])
@pytest.mark.parametrize("line", LINES)
async def test_a_json_line_is_the_reads_answer(monkeypatch, tool, line):
    rows = _patch_audit(monkeypatch)
    _events, entry, text = await _read(_Service([line]), tool=tool)
    assert (rows[0]["result"], rows[0]["error"], rows[0]["after"]["status"]) == ("success", None, None)
    assert json.loads(text) == json.loads(line)  # the model reads what it read


@pytest.mark.asyncio
@pytest.mark.parametrize("answer, want", [
    (json.dumps({"error": "Error in k8s_get_pod_logs: web-1 timed out"}, ensure_ascii=False), ("failure", "Error in k8s_get_pod_logs: web-1 timed out", None)),
    (json.dumps({"error": "권한 없음: 'k8s_get_pod_logs'는 read 역할에서 사용할 수 없습니다."}, ensure_ascii=False),
     ("failure", "권한 없음: 'k8s_get_pod_logs'는 read 역할에서 사용할 수 없습니다.", None)),
    (json.dumps({"status": "forbidden", "reason": "pods/log", "hint": "x"}), ("failure", "forbidden", "forbidden")),
    (json.dumps({"status": "forbidden", "message": "forbidden: namespace 'db' is outside your grant on self (apps)"}, ensure_ascii=False), ("failure", "forbidden", "forbidden")),
    (json.dumps({"status": "not_found", "kind": "pods", "name": "web-1", "namespace": "apps", "similar": [], "searched": "all namespaces", "hint": "x"}), ("success", None, "not_found")),
    ("ready\n", ("success", None, None)),
])
async def test_what_kubeast_answered_in_its_place_is_read_as_it_was(monkeypatch, answer, want):
    rows = _patch_audit(monkeypatch)
    await _read(_Service([answer]))
    assert (rows[0]["result"], rows[0]["error"], rows[0]["after"]["status"]) == want


@pytest.mark.asyncio
async def test_other_tools_are_read_as_they_were(monkeypatch):
    rows = _patch_audit(monkeypatch)
    for answer, want in (('{"error": "boom"}', ("failure", "boom", None)), ('{"status": "forbidden", "x": 1}', ("failure", "forbidden", "forbidden"))):
        await _read(_Service([answer]), tool="k8s_get_resources", args={"resource_type": "pods"})
        assert (rows[-1]["result"], rows[-1]["error"], rows[-1]["after"]["status"]) == want


def test_a_commands_output_is_read_as_it_was():
    """A write (a command run in a container) keeps its reading: its row is the action's outcome."""
    for tool in ("k8s_execute_command", "k8s_scale"):
        assert streaming.read_outcome(tool, '{"error": "boom"}', None) == ("failure", "boom", None)


@pytest.mark.asyncio
async def test_a_recorded_answers_own_refusal_is_one_of_ai_services(monkeypatch):
    rows = _patch_audit(monkeypatch)
    miss = json.dumps({"error": "No recorded answer", "status": "replay_miss"})
    monkeypatch.setattr(tool_replay, "call_fields", lambda service, ran: {"replay": True, "replay_hit": False})
    await _read(_Service([miss]))
    assert (rows[0]["result"], rows[0]["error"]) == ("failure", "No recorded answer")


@pytest.mark.asyncio
async def test_a_json_line_is_held_as_any_answer_and_a_refusal_is_not(monkeypatch):
    _patch_audit(monkeypatch)
    grant = json.dumps({"status": "forbidden", "message": "forbidden: namespace 'db' is outside your grant on self (apps)"}, ensure_ascii=False)
    service = _Service([LINES[0]])
    guard = repeats.RepeatGuard(clock=lambda: 50.0)
    await _read(service, guard)
    assert json.loads((await _read(service, guard, step=2))[2])["status"] == "repeated" and len(service.executed) == 1
    service, guard = _Service([grant, grant]), repeats.RepeatGuard(clock=lambda: 50.0)
    await _read(service, guard)
    await _read(service, guard, step=2)
    assert len(service.executed) == 2


@pytest.mark.asyncio
async def test_a_read_that_left_no_row_is_not_held(monkeypatch):
    """The row could not be stored: the answer is dropped, and the same read may be made again."""
    async def ready():
        return True, None

    async def lost(**kw):
        return False

    monkeypatch.setattr("app.services.audit_writer.audit_ready", ready)
    monkeypatch.setattr("app.services.audit_writer.write_audit", lost)
    monkeypatch.setattr("app.services.audit_writer.fail_closed_enabled", lambda: True)
    service, guard = _Service([LINES[0], LINES[0]]), repeats.RepeatGuard(clock=lambda: 50.0)
    text = (await _read(service, guard))[2]
    assert json.loads(text)["status"] == "audit_unavailable"
    await _read(service, guard, step=2)
    assert len(service.executed) == 2
