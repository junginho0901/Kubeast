"""Credentials in the shapes the plain key rule misses: a value under a block indicator, a container env entry, a number.
The cases are shared with services/pkg/redact (TestSharedShapeCases), so the two rule lists stay the same, and each has
the values that must stay: a setting, a count or a reference that vanished would make the answer wrong."""
import copy
import json
from pathlib import Path

import pytest

from app.models.floating_ai import PageContextPayload, VisibleDataLayer
from app.prompts.floating_system_prompt import build_context_prompt
from app.services import redact

CASES = json.loads((Path(__file__).parent / "fixtures" / "redact_shape_cases.json").read_text())


@pytest.fixture(autouse=True)
def _default_rules(monkeypatch):
    for name in ("REDACTION_ENABLED", "REDACTION_PII", "REDACTION_DISABLE"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("case", CASES["text"], ids=lambda c: c["name"])
def test_text_shapes(case):
    assert redact.redact_text(case["input"], redact.Options())[0] == case["want"]


@pytest.mark.parametrize("case", CASES["objects"], ids=lambda c: c["name"])
def test_object_shapes(case):
    assert redact.redact_object(copy.deepcopy(case["input"]), redact.Options())[0] == case["want"]


def test_masking_is_counted_for_the_audit_row():
    _, stats = redact.redact_text("token: |\n  fake-block-value\n", redact.Options())
    assert stats.kinds == {"key_name": 1}
    _, stats = redact.redact_object({"name": "DB_PASSWORD", "value": 1234}, redact.Options())
    assert stats.kinds == {"key_name": 1}


def test_the_key_rule_switch_covers_the_new_shapes():
    off = redact.Options(disabled={"key_name"})
    assert redact.redact_object({"name": "DB_PASSWORD", "value": "fake-password-1"}, off)[0]["value"] == "fake-password-1"
    assert redact.redact_object({"password": 1234}, off)[0]["password"] == 1234
    assert "fake-block-value" in redact.redact_text("token: |\n  fake-block-value\n", off)[0]
    assert "fake-pass-1" in redact.redact_text("login password=fake-pass-1 now", off)[0]
    assert "fake pass 1" in redact.redact_text('login password="fake pass 1" now', off)[0]
    assert redact.redact_text("login password=fake-pass-1 now", redact.Options())[1].kinds == {"key_name": 1}


def test_the_floating_snapshot_loses_the_credential_and_keeps_the_rest():
    pod = {
        "kind": "Pod",
        "metadata": {"name": "web-0"},
        "spec": {"containers": [{"name": "app", "env": [{"name": "DB_PASSWORD", "value": "fake-password-1"}, {"name": "LOG_LEVEL", "value": "debug"}]}]},
    }
    ctx = PageContextPayload(
        page_type="resource-list", page_title="Pods", path="/workloads/pods", snapshot_at="2026-11-07T00:00:00Z",
        base=VisibleDataLayer(source="base", summary="pods", data={"pods": [pod], "password": 1234, "replicas": 3}),
        overlays=[VisibleDataLayer(source="ResourceDetailDrawer", summary="web-0", data={"yaml": "password: 1234\ntoken: |\n  fake-block-value\nimage: nginx:1.27\n"})],
    )
    text = build_context_prompt(ctx)
    for gone in ("fake-password-1", "1234", "fake-block-value"):
        assert gone not in text
    for kept in ("web-0", '"LOG_LEVEL","value":"debug"', '"replicas":3', "nginx:1.27"):
        assert kept in text
