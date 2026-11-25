"""The changes view's further sources (AI_TIMELINE_CHANGES_MORE, chart ai.timelineChangesMore, off by default) are said by
the view's description and the prompt only where the view is offered with them; off, both are what they were."""
import re
from pathlib import Path

import pytest

from app.services.ai import prompts, tools

ROOT = Path(__file__).resolve().parents[3]
SWITCHES = ("AI_TIMELINE_CHANGES", "AI_TIMELINE_CHANGES_MORE", "ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED")
OTHERS = ((), ("ANOMALY_RANK_ENABLED",), ("CALL_GRAPH_ENABLED",), ("ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED"))


def _only(monkeypatch, *on):
    for name in SWITCHES:
        monkeypatch.delenv(name, raising=False)
    for name in on:
        monkeypatch.setenv(name, "true")


def _offered():
    return tools.offer_timeline_changes(tools.K8S_READONLY_TOOLS), prompts.system_message()


def _description():
    (timeline,) = [t for t in tools.offer_timeline_changes(tools.K8S_READONLY_TOOLS) if t["function"]["name"] == "timeline"]
    return timeline["function"]["description"]


def test_the_sentence_names_the_sources_k8s_service_reads():
    # a new source changes the sentence
    text = (ROOT / "services/k8s-service-go/internal/k8s/timeline_changes_more.go").read_text(encoding="utf-8")
    (listed,) = re.findall(r"var timelineMoreChangeSources = \[\]string\{([^}]*)\}", text)
    assert re.findall(r'"([a-z_]+)"', listed) == ["jobs", "networkpolicies", "services", "deployment_replicas", "statefulset_replicas"]
    for words in ("Jobs", "CronJob", "NetworkPolicy", "Service", "selector", "ports", "replica counts", "Deployment", "StatefulSet", "never a value"):
        assert words in tools.TIMELINE_CHANGES_MORE


@pytest.mark.parametrize("others", OTHERS)
def test_without_the_view_the_switch_changes_nothing(monkeypatch, others):
    _only(monkeypatch, *others)
    off = _offered()
    _only(monkeypatch, "AI_TIMELINE_CHANGES_MORE", *others)
    assert _offered() == off


@pytest.mark.parametrize("others", OTHERS)
def test_with_the_view_the_description_and_the_prompt_say_the_sources(monkeypatch, others):
    _only(monkeypatch, "AI_TIMELINE_CHANGES", *others)
    before, prompt_before = _description(), prompts.system_message()
    assert tools.TIMELINE_CHANGES_NOT_LISTED in before and tools.TIMELINE_CHANGES_MORE not in before
    _only(monkeypatch, "AI_TIMELINE_CHANGES", "AI_TIMELINE_CHANGES_MORE", *others)
    assert _description() == before.replace(
        tools.TIMELINE_CHANGES_NOT_LISTED, tools.TIMELINE_CHANGES_MORE + tools.TIMELINE_CHANGES_MORE_NOT_LISTED)
    changed = [(a, b) for a, b in zip(prompt_before.split("\n"), prompts.system_message().split("\n"), strict=True) if a != b]
    assert len(changed) == 2 and all("changes" in b for _, b in changed)
    assert "ScalingReplicaSet" not in prompts.system_message() and "Job 생성" in prompts.system_message()
    for words in ("deleted object", 'not "nothing changed"', "events view"):
        assert words in tools.TIMELINE_CHANGES_MORE_NOT_LISTED


def test_the_mcp_timeline_says_it_with_the_switches(monkeypatch):
    from app import mcp_server

    _only(monkeypatch, "AI_TIMELINE_CHANGES")
    assert tools.TIMELINE_CHANGES_MORE not in mcp_server._read_tools()["timeline"].description
    _only(monkeypatch, "AI_TIMELINE_CHANGES", "AI_TIMELINE_CHANGES_MORE")
    assert tools.TIMELINE_CHANGES_MORE in mcp_server._read_tools()["timeline"].description
