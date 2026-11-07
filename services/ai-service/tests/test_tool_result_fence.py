"""A tool result goes in a code block no line of it can close, in every answer the server saves: the block outlasts the
result's longest run of backticks. The same cases and text as the frontend's chatStreamManager.test.ts, because the
saved answer and the live one must match."""
from types import SimpleNamespace

import pytest

from app.services.ai import history
from app.services.ai.streaming import tool_block_markdown


def code_block_after(text: str, heading: str) -> str:
    """The body of the code block that follows heading, read the way a Markdown parser reads it: a closing line is
    only backticks, at least as many as opened the block."""
    lines = text[text.index(heading) + len(heading):].split("\n")
    start = next(i for i, line in enumerate(lines) if line.startswith("```"))
    opening = len(lines[start]) - len(lines[start].lstrip("`"))
    for end in range(start + 1, len(lines)):
        stripped = lines[end].strip()
        if len(stripped) >= opening and set(stripped) == {"`"}:
            return "\n".join(lines[start + 1:end])
    raise AssertionError("the code block never closes")


CASES = [
    ("pod-a Running", "```\npod-a Running\n```"),
    ("a `b` ``c``", "```\na `b` ``c``\n```"),
    ("a\n```\nb", "````\na\n```\nb\n````"),
    ("a\n`````\nb\n```\nc", "``````\na\n`````\nb\n```\nc\n``````"),
    ("a\n   ```\nb", "````\na\n   ```\nb\n````"),
    ("a ``` b", "````\na ``` b\n````"),
]


@pytest.mark.parametrize("result,block", CASES)
def test_a_code_block_outlasts_the_backticks_in_its_result(result, block):
    out = tool_block_markdown({"function": "k8s_pod_logs", "args": {}, "result": result})
    assert f"<summary><strong>📊 Results</strong></summary>\n\n{block}\n\n</details>" in out
    assert code_block_after(out, "📊 Results") == result


def test_a_longer_code_block_keeps_its_language():
    json_block = tool_block_markdown({"function": "t", "args": {}, "result": "```", "is_json": True})
    assert "````json\n```\n````" in json_block
    yaml_block = tool_block_markdown({"function": "t", "args": {}, "result": "```", "is_yaml": True})
    assert "````yaml\n```\n````" in yaml_block
    shown = tool_block_markdown({"function": "t", "args": {}, "result": "{}", "is_json": True, "display": "a\n```\nb"})
    assert "````\na\n```\nb\n````" in shown


def test_an_ordinary_result_is_written_as_before():
    out = tool_block_markdown({"function": "t", "args": {}, "result": '["self"]', "is_json": True})
    assert '```json\n["self"]\n```' in out
    assert "````" not in out


@pytest.mark.asyncio
async def test_an_approved_write_keeps_its_result_in_its_code_block(monkeypatch):
    import app.api as api
    from app.services import audit_writer

    result = "line 1\n```\n<style>x{}</style>\n```\nline 2"
    approval = SimpleNamespace(id="ap1", user_id="u1", cluster="self", tool="k8s_scale",
                               args={"resource_type": "deployment", "resource_name": "web", "namespace": "shop", "replicas": 2},
                               session_id="s1", result="", status="pending", created_at=None, expires_at=None, decided_at=None)
    messages = []

    class DB:
        async def transition_tool_approval(self, *a, **k):
            for key, value in k.items():
                setattr(approval, key, value)
            return approval

        async def add_message(self, *a, **k):
            messages.append(a[2])

    async def load(approval_id, payload):
        return DB(), approval

    class Service:
        tool_server = SimpleNamespace(last_access=None, last_requests=None)

        async def _call_tool_server(self, tool, args, **kw):
            return result

    async def build(authorization, cluster_name=None):
        return Service()

    async def write(**kw):
        return True

    async def ready():
        return None

    monkeypatch.setattr(audit_writer, "write_audit", write)
    monkeypatch.setattr(audit_writer, "require_audit_ready", ready)
    monkeypatch.setattr(api, "_load_own_pending_approval", load)
    monkeypatch.setattr(api, "_caller", lambda auth: SimpleNamespace(user_id="u1", has_permission_for_cluster=lambda perm, cluster: True))
    monkeypatch.setattr(api, "_extract_audit_meta", lambda request, auth: ({"user_id": "u1", "email": "dev@example.com"}, {}))
    monkeypatch.setattr(api, "_build_ai_service", build)
    monkeypatch.setattr("app.services.approval_token.sign", lambda *a, **k: "tok")
    await api.approve_tool_approval("ap1", request=SimpleNamespace(), authorization="Bearer x")
    assert code_block_after(messages[0], "was approved and") == approval.result
    assert "<style>" in approval.result


def test_the_history_drops_a_longer_code_block_whole():
    answer = "Before.\n\n````\nfirst\n```\nsecond\n```\nthird\n````\n\nAfter."
    plain = history.to_plain(answer)
    assert plain == "Before.\n\n[output omitted]\n\nAfter."


def test_the_history_still_drops_a_plain_code_block():
    assert history.to_plain("Before.\n\n```\nfirst\n```\n\nAfter.") == "Before.\n\n[output omitted]\n\nAfter."
