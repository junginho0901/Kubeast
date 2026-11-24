"""timeline's changes view lists only what its sources keep (k8s-service timelineChangeSources): a replica count set by
hand (kubectl scale), a deleted object and a change to another kind are not in it. With AI_TIMELINE_CHANGES on, the
view's description and the prompt's timeline line say so, so an answer without a change is not read as "nothing
changed"; off, neither says it."""
import re
from pathlib import Path

import pytest

from app.services.ai import prompts, tools

ROOT = Path(__file__).resolve().parents[3]
SWITCHES = ("AI_TIMELINE_CHANGES", "ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED")


def _only(monkeypatch, *on):
    for name in SWITCHES:
        monkeypatch.delenv(name, raising=False)
    for name in on:
        monkeypatch.setenv(name, "true")


def _description():
    (timeline,) = [t for t in tools.offer_timeline_changes(tools.K8S_READONLY_TOOLS) if t["function"]["name"] == "timeline"]
    return timeline["function"]["description"]


def test_the_view_reads_no_scale_no_service_and_no_network_policy():
    # The sentence is true while these are the view's sources; a new source changes it.
    text = (ROOT / "services/k8s-service-go/internal/k8s/timeline_changes.go").read_text(encoding="utf-8")
    (listed,) = re.findall(r"var timelineChangeSources = \[\]string\{([^}]*)\}", text)
    assert re.findall(r'"([a-z]+)"', listed) == ["rollouts", "configmaps", "secrets", "helm", "hpas", "nodes", "pods", "argocd"]


@pytest.mark.parametrize("on, last_words", [
    (("AI_TIMELINE_CHANGES",), tools.TIMELINE_FIRST),
    (("AI_TIMELINE_CHANGES", "ANOMALY_RANK_ENABLED"), tools.TIMELINE_AFTER_ANOMALY_RANK),
])
def test_on_the_description_says_what_the_view_does_not_list(monkeypatch, on, last_words):
    _only(monkeypatch, *on)
    description = _description()
    assert tools.TIMELINE_CHANGES_NOT_LISTED in description and description.endswith(last_words)
    for words in ("kubectl scale", "ScalingReplicaSet", "deleted object", "Service", "NetworkPolicy", 'not "nothing changed"', "events view"):
        assert words in tools.TIMELINE_CHANGES_NOT_LISTED


@pytest.mark.parametrize("on", [
    ("AI_TIMELINE_CHANGES",),
    ("AI_TIMELINE_CHANGES", "ANOMALY_RANK_ENABLED"),
    ("AI_TIMELINE_CHANGES", "CALL_GRAPH_ENABLED"),
    ("AI_TIMELINE_CHANGES", "ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED"),
])
def test_on_the_prompts_timeline_line_says_it_whichever_order_rule_is_on(monkeypatch, on):
    _only(monkeypatch, *on)
    lines = prompts.system_message().split("\n")
    saying = [line for line in lines if "ScalingReplicaSet" in line]
    assert saying == [prompts.TIMELINE_CHANGES_LINES[prompts._TIMELINE_GUIDE]]
    assert all(words in saying[0] for words in ("`kubectl scale`", "지운 객체", "Service·NetworkPolicy", '"바뀐 것 없음"이 아닙니다', "`view` 없이"))


def test_off_neither_the_description_nor_the_prompt_says_it(monkeypatch):
    _only(monkeypatch, "ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED")
    assert "ScalingReplicaSet" not in _description() and "kubectl scale" not in _description()
    _only(monkeypatch)
    assert prompts.system_message() == prompts.SYSTEM_MESSAGE and "ScalingReplicaSet" not in prompts.SYSTEM_MESSAGE


def test_the_mcp_timeline_says_it_only_with_the_switch(monkeypatch):
    from app import mcp_server

    _only(monkeypatch)
    assert "ScalingReplicaSet" not in mcp_server._read_tools()["timeline"].description
    _only(monkeypatch, "AI_TIMELINE_CHANGES")
    assert tools.TIMELINE_CHANGES_NOT_LISTED in mcp_server._read_tools()["timeline"].description
