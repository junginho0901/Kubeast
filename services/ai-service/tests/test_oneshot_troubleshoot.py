"""/troubleshoot puts pod logs and events in front of the model — they must be
redacted first, the same way /analyze-logs and /explain-resource inputs are."""

import json
from types import SimpleNamespace

from app.models.ai import TroubleshootRequest
from app.services.ai import oneshot


class _Completions:
    def __init__(self):
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        content = json.dumps({"diagnosis": "d", "severity": "low", "root_causes": [], "solutions": [], "preventive_measures": []})
        message = SimpleNamespace(role="assistant", content=content, tool_calls=None)
        choice = SimpleNamespace(index=0, message=message, finish_reason="stop")
        return SimpleNamespace(id="r1", model="m", created=0, choices=[choice], usage=None)


class _Service:
    model = "m"

    def __init__(self):
        self.client = SimpleNamespace(chat=SimpleNamespace(completions=_Completions()))

    async def _gather_resource_context(self, request):
        return (
            "Pod Status: Running\n"
            "Logs:\n"
            "DB_PASSWORD=hunter2-ctx\n"
            "connecting to postgres://app:s3cr3t-ctx@db:5432/app\n"
            "kind: Secret\ndata:\n  token: dG9rZW4tY3R4\n"
        )


async def test_troubleshoot_prompt_is_redacted():
    svc = _Service()
    req = TroubleshootRequest(namespace="default", resource_type="pod", resource_name="web-0")
    res = await oneshot.troubleshoot(svc, req)
    assert res.diagnosis == "d"

    prompt = svc.client.chat.completions.calls[0]["messages"][1]["content"]
    for gone in ["hunter2-ctx", "s3cr3t-ctx", "dG9rZW4tY3R4"]:
        assert gone not in prompt, prompt
    assert "<REDACTED" in prompt
    assert "Pod Status: Running" in prompt
