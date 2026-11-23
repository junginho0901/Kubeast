"""Rule cards (ai.ruleCards): the defaults name tools that exist and only read, the server picks at most two from an
alert's name and labels or a question, they reach the model with only the tools it is offered, the chart adds and
removes cards, and with both switches off the investigation and the chat read as before."""

import json
import logging
from types import SimpleNamespace

import pytest

from app.services import rule_cards
from app.services.ai.tools import get_tools_definition
from app.services.investigation import prompt as inv_prompt
from app.services.investigation import runner
from app.services.tool_whitelists import READONLY_TOOL_NAMES
from tests.test_alert_investigation import FakeService, cfg, completion, install_loop, row
from tests.test_chat_turn_edges import parsed, stream, text_chunk
from tests.test_switch_cases import CASES

# The hard evaluation cases' kinds of failure, "none" (no failure) aside.
KINDS = ["crash", "oom", "image", "config_change", "rollout", "network_policy", "dns", "resource_limit", "quota", "node",
         "dependency_down", "dependency_slow", "storage"]
DEFAULTS = rule_cards.cards_of("", "")
BY_KIND = {card.kind: card for card in DEFAULTS}
DEFINED = {tool["function"]["name"] for tool in get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda tools: tools))}
ALL_TOOLS = sorted(DEFINED)
# Words nearly every alert carries in a label value (job, service, namespace, severity, container): a card picked by one
# of them would come with alerts it has nothing to do with.
COMMON_WORDS = {"node", "nodes", "exporter", "kube", "kubelet", "kubernetes", "pod", "pods", "container", "job", "service",
                "namespace", "prometheus", "monitoring", "default", "warning", "critical", "info", "error", "true", "false",
                "image", "memory", "cpu", "disk", "app", "apps", "state", "metrics", "api", "server", "http", "https"}


def kinds(cards):
    return [card.kind for card in cards]


def raw_card(kind="payments-db", **kw):
    base = {"kind": kind, "title": "Payments database slow", "alerts": ["PaymentsDBLatencyHigh"], "terms": ["pq canceling statement"],
            "checks": [{"check": "The database's slow queries over the window", "tools": ["prometheus_query"]}]}
    base.update(kw)
    return base


# --- the defaults -------------------------------------------------------------------------------------------------


def test_the_defaults_are_one_card_per_kind_of_failure_of_the_hard_cases():
    assert kinds(rule_cards.defaults()) == KINDS


@pytest.mark.parametrize("kind", KINDS)
def test_each_check_of_a_default_card_names_tools_that_exist_and_only_read(kind):
    # A renamed or removed tool fails here, as test_named_tools_exist does for the prompts.
    for check in BY_KIND[kind].checks:
        assert set(check.tools) <= DEFINED, (check.text, set(check.tools) - DEFINED)
        assert set(check.tools) <= READONLY_TOOL_NAMES, (check.text, set(check.tools) - READONLY_TOOL_NAMES)


@pytest.mark.parametrize("kind", KINDS)
def test_no_default_card_is_picked_by_a_word_every_alert_carries(kind):
    card = BY_KIND[kind]
    for term in (*card.alerts, *card.terms):
        assert rule_cards.words(term).strip() not in COMMON_WORDS, term


def test_the_two_longest_default_cards_stay_short_beside_the_first_message():
    longest = 0
    for a in DEFAULTS:
        for b in DEFAULTS:
            if a is not b:
                longest = max(longest, len(rule_cards.render([a, b], ALL_TOOLS, source=rule_cards.INVESTIGATION_SOURCE)[0]))
    assert 0 < longest <= 2000


# --- picking ------------------------------------------------------------------------------------------------------


def test_the_alerts_own_name_picks_first_then_a_reason_in_its_labels():
    labels = {"alertname": "KubePodCrashLooping", "reason": "OOMKilled", "job": "kube-state-metrics", "namespace": "shop"}
    assert kinds(rule_cards.pick(DEFAULTS, alertname="KubePodCrashLooping", labels=labels)) == ["crash", "oom"]
    labels = {"alertname": "KubeContainerWaiting", "reason": "ImagePullBackOff", "container": "web"}
    assert kinds(rule_cards.pick(DEFAULTS, alertname="KubeContainerWaiting", labels=labels)) == ["image"]


def test_at_most_two_cards_and_the_alert_name_before_its_labels():
    labels = {"reason": "ImagePullBackOff", "condition": "MemoryPressure", "detail": "OOMKilled"}
    picked = rule_cards.pick(DEFAULTS, alertname="KubeQuotaExceeded", labels=labels)
    assert kinds(picked)[0] == "quota" and len(picked) == 2
    assert len(rule_cards.pick(DEFAULTS, alertname="KubeQuotaExceeded", labels=labels, limit=4)) == 4
    # in a tie the card with more matches, then the cards' order
    assert kinds(rule_cards.pick(DEFAULTS, labels={"a": "ImagePullBackOff", "b": "OOMKilled", "c": "exit code 137"})) == ["oom", "image"]
    assert kinds(rule_cards.pick(DEFAULTS, labels={"a": "ImagePullBackOff", "b": "OOMKilled"})) == ["oom", "image"]


def test_an_alert_that_names_no_failure_a_card_knows_picks_none():
    labels = {"alertname": "Watchdog", "job": "node-exporter", "namespace": "monitoring", "severity": "warning", "service": "kubelet"}
    assert rule_cards.pick(DEFAULTS, alertname="Watchdog", labels=labels) == []
    assert rule_cards.pick(DEFAULTS) == []


def test_a_term_matches_whole_words_in_labels_and_inside_an_alert_name_written_as_one_word():
    assert rule_cards.pick(DEFAULTS, alertname="Custom", labels={"metric": "oomkilledcount"}) == []
    assert kinds(rule_cards.pick(DEFAULTS, alertname="PaymentsOOMKilled", labels={})) == ["oom"]
    assert kinds(rule_cards.pick(DEFAULTS, alertname="Custom", labels={"message": "dial tcp: lookup db: no such host"})) == ["dns"]


def test_other_text_picks_after_the_alert_as_narrowings_findings_will():
    findings = ["crash_reasons: OOMKilled 3 (was 0)"]
    assert kinds(rule_cards.pick(DEFAULTS, alertname="Custom", labels={}, texts=findings)) == ["oom"]
    assert kinds(rule_cards.pick(DEFAULTS, alertname="KubeDeploymentRolloutStuck", labels={}, texts=findings)) == ["rollout", "oom"]


def test_the_question_picks_by_the_failure_it_names():
    assert kinds(rule_cards.pick(DEFAULTS, texts=["shop의 web 파드가 OOMKilled가 나는데 왜 그래?"])) == ["oom"]
    assert kinds(rule_cards.pick(DEFAULTS, texts=["KubePodCrashLooping 알림이 왜 울려?"])) == ["crash"]
    assert rule_cards.pick(DEFAULTS, texts=["파드 몇 개야?"]) == []
    assert rule_cards.pick(DEFAULTS, texts=["how many pods run on each node?"]) == []


# --- what the model reads -----------------------------------------------------------------------------------------


def test_a_card_keeps_only_the_offered_tools_and_drops_a_check_with_none():
    text, got = rule_cards.render([BY_KIND["crash"]], {"k8s_get_pod_logs", "timeline"}, source=rule_cards.INVESTIGATION_SOURCE)
    assert got == ["crash"]
    assert text.startswith("Rule cards, picked by the server from the alert's name and labels")
    assert "\n1. The log of the run that stopped (previous=true): the last lines before the exit — k8s_get_pod_logs\n" in text
    assert "\n2. A rollout, ConfigMap or Secret change just before the first restart — timeline" in text
    assert "k8s_describe_resource" not in text and "3." not in text
    assert "name a cause only from what a tool showed" in text


def test_a_card_with_no_offered_tool_is_left_out():
    assert rule_cards.render([BY_KIND["network_policy"]], {"k8s_get_pod_logs"}, source="x") == ("", [])
    text, got = rule_cards.render([BY_KIND["network_policy"], BY_KIND["crash"]], {"k8s_get_pod_logs"}, source="x")
    assert got == ["crash"] and 'Card "network_policy"' not in text


def test_the_block_never_passes_its_limit():
    big = rule_cards.card_of(raw_card(
        kind="big", title="t" * rule_cards.MAX_TITLE_CHARS,
        checks=[{"check": "c" * rule_cards.MAX_CHECK_CHARS, "tools": ALL_TOOLS[:rule_cards.MAX_TOOLS]}] * rule_cards.MAX_CHECKS))
    text, got = rule_cards.render([big, big, big], ALL_TOOLS, source=rule_cards.INVESTIGATION_SOURCE)
    assert len(text) <= rule_cards.MAX_BLOCK_CHARS and got == ["big", "big"]


# --- the chart's cards --------------------------------------------------------------------------------------------


def test_the_chart_adds_replaces_in_place_and_removes_cards():
    replaced = raw_card(kind="oom", title="Our OOM", alerts=["WorkerOOM"], terms=[])
    cards = rule_cards.cards_of(json.dumps([raw_card(), replaced]), "network_policy, dns")
    assert kinds(cards) == [k for k in KINDS if k not in ("network_policy", "dns")] + ["payments-db"]
    oom = next(c for c in cards if c.kind == "oom")
    assert oom.title == "Our OOM" and oom.alerts == ("WorkerOOM",)
    assert kinds(rule_cards.pick(cards, alertname="PaymentsDBLatencyHigh")) == ["payments-db"]


@pytest.mark.parametrize("bad", [
    raw_card(kind="Payments"),
    raw_card(title=""),
    raw_card(alerts=[], terms=[]),
    raw_card(terms=["--"]),
    raw_card(checks=[]),
    raw_card(checks=[{"check": "c", "tools": []}]),
    raw_card(checks=[{"check": "c", "tools": ["a", "b", "c", "d"]}]),
    raw_card(checks=[{"check": "c" * 201, "tools": ["issues"]}]),
    raw_card(checks=[{"check": "c", "tools": ["issues"]}] * 7),
    raw_card(alerts="PaymentsDBLatencyHigh"),
    "a card",
], ids=["kind", "title", "nothing-picks-it", "term-without-a-word", "no-checks", "no-tool", "four-tools", "long-check",
        "seven-checks", "alerts-not-a-list", "not-an-object"])
def test_a_card_the_chart_got_wrong_is_left_out_with_why(bad, caplog):
    with caplog.at_level(logging.WARNING, logger=rule_cards.__name__):
        cards = rule_cards.cards_of(json.dumps([bad, raw_card(kind="kept")]), "")
    assert kinds(cards) == KINDS + ["kept"]
    assert any("left out" in r.getMessage() for r in caplog.records if r.name == rule_cards.__name__)


def test_chart_cards_that_are_not_a_json_list_leave_the_defaults(caplog):
    with caplog.at_level(logging.WARNING, logger=rule_cards.__name__):
        assert kinds(rule_cards.cards_of("{not json", "")) == KINDS
        assert kinds(rule_cards.cards_of('{"kind": "oom"}', "")) == KINDS
    assert len([r for r in caplog.records if r.name == rule_cards.__name__]) == 2


# --- the switches -------------------------------------------------------------------------------------------------


def test_both_switches_are_off_by_default_and_read_no_cards(monkeypatch, tmp_path):
    for name in ("AI_RULE_CARDS_CHAT", "AI_RULE_CARDS_INVESTIGATIONS", "AI_RULE_CARDS", "AI_RULE_CARDS_REMOVE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(rule_cards, "DEFAULTS_FILE", tmp_path / "missing.json")
    assert rule_cards.load() == rule_cards.Settings(chat=False, investigations=False, cards=())


def test_the_switches_and_the_chart_cards_come_from_the_environment(monkeypatch):
    monkeypatch.delenv("AI_RULE_CARDS_CHAT", raising=False)
    monkeypatch.setenv("AI_RULE_CARDS_INVESTIGATIONS", "true")
    monkeypatch.setenv("AI_RULE_CARDS", json.dumps([raw_card()]))
    monkeypatch.setenv("AI_RULE_CARDS_REMOVE", "storage")
    s = rule_cards.load()
    assert (s.chat, s.investigations) == (False, True)
    assert kinds(s.cards) == [k for k in KINDS if k != "storage"] + ["payments-db"]
    monkeypatch.setenv("AI_RULE_CARDS_CHAT", "TRUE")
    assert rule_cards.load().chat is True


@pytest.mark.parametrize("case", CASES, ids=lambda c: repr(c["value"]))
@pytest.mark.parametrize("name, field", [("AI_RULE_CARDS_CHAT", "chat"), ("AI_RULE_CARDS_INVESTIGATIONS", "investigations")])
def test_each_switch_reads_the_one_switch_rule(monkeypatch, case, name, field):
    for other in ("AI_RULE_CARDS_CHAT", "AI_RULE_CARDS_INVESTIGATIONS"):
        monkeypatch.delenv(other, raising=False)
    monkeypatch.setenv(name, case["value"])
    assert getattr(rule_cards.load(), field) is case["on"]


# --- an investigation ---------------------------------------------------------------------------------------------


class DescribingService(FakeService):
    def _get_tools_definition(self):
        return super()._get_tools_definition() + [{"type": "function", "function": {"name": "k8s_describe_resource"}}]


def first_message(service):
    return service.completions.calls[0]["messages"][1]["content"]


@pytest.mark.asyncio
async def test_with_the_switch_off_an_investigations_first_message_is_as_it_was(monkeypatch):
    monkeypatch.delenv("AI_RULE_CARDS_INVESTIGATIONS", raising=False)
    monkeypatch.setenv("AI_RULE_CARDS_CHAT", "true")  # the chat's switch does not reach an investigation
    service = DescribingService([completion(content="## Summary\nok")])
    install_loop(monkeypatch, service, [])
    r = row(labels={"alertname": "KubePodCrashLooping", "reason": "OOMKilled"})
    out = await runner.investigate(cfg(max_steps=5), r)
    first = first_message(service)
    assert first == inv_prompt.alert_message(cluster="self", alert=runner.alert_view(r))
    assert first.endswith("ALERT>>>\nInvestigate it now.") and "Rule cards" not in first
    assert inv_prompt.alert_message(cluster="self", alert={}) == inv_prompt.alert_message(cluster="self", alert={}, context="")
    assert service.executed == [] and out["tool_calls"] == [] and out["report"] == "## Summary\nok"


@pytest.mark.asyncio
async def test_with_the_switch_on_the_picked_cards_go_beside_the_alert_with_the_offered_tools(monkeypatch):
    monkeypatch.setenv("AI_RULE_CARDS_INVESTIGATIONS", "true")
    service = DescribingService([completion(content="## Summary\nok")])
    install_loop(monkeypatch, service, [])
    r = row(labels={"alertname": "KubePodCrashLooping", "reason": "OOMKilled"})
    out = await runner.investigate(cfg(max_steps=5), r)
    sent = service.completions.calls[0]["messages"]
    assert sent[0]["content"] == inv_prompt.system_prompt(cluster="self", namespace="apps", language="en")
    first = sent[1]["content"]
    assert first.index("ALERT>>>") < first.index('Card "crash"') < first.index('Card "oom"') < first.index("Investigate it now.")
    # offered: k8s_get_resources, k8s_get_pod_logs, k8s_describe_resource (the write tool is not offered to an investigation)
    assert "— k8s_get_pod_logs" in first and "— k8s_describe_resource" in first and "timeline" not in first
    assert "k8s_delete_resource" not in first
    # no model step and no tool call spent on them
    assert len(service.completions.calls) == 1 and service.executed == [] and out["tool_calls"] == []


@pytest.mark.asyncio
async def test_an_alert_no_card_knows_leaves_the_first_message_as_it_was(monkeypatch):
    monkeypatch.setenv("AI_RULE_CARDS_INVESTIGATIONS", "true")
    service = DescribingService([completion(content="## Summary\nok")])
    install_loop(monkeypatch, service, [])
    r = row(alertname="Watchdog", labels={"alertname": "Watchdog", "job": "node-exporter"})
    await runner.investigate(cfg(max_steps=5), r)
    assert first_message(service) == inv_prompt.alert_message(cluster="self", alert=runner.alert_view(r))


async def run_row(monkeypatch, r):
    """The ai.investigation.run row's `after` of one run of `r`."""
    service = DescribingService([completion(content="## Summary\nok")])
    audits = []
    install_loop(monkeypatch, service, audits)

    async def finish(db, inv_id, **f):
        return None

    monkeypatch.setattr(runner.store, "finish", finish)
    assert await runner.run_one(cfg(max_steps=5), None, r) == "done"
    assert audits[-1]["action"] == "ai.investigation.run"
    return audits[-1]["after"]


@pytest.mark.asyncio
async def test_the_run_row_names_the_kinds_of_the_cards_it_was_given_and_nothing_with_the_switch_off(monkeypatch):
    crash = row(labels={"alertname": "KubePodCrashLooping", "reason": "OOMKilled"})
    monkeypatch.delenv("AI_RULE_CARDS_INVESTIGATIONS", raising=False)
    off = await run_row(monkeypatch, crash)
    assert "rule_cards" not in off
    monkeypatch.setenv("AI_RULE_CARDS_INVESTIGATIONS", "true")
    on = await run_row(monkeypatch, crash)
    assert on["rule_cards"] == ["crash", "oom"]  # kinds only: no title or check text
    assert {k: v for k, v in on.items() if k not in ("rule_cards", "duration_ms")} == {k: v for k, v in off.items() if k != "duration_ms"}
    none = await run_row(monkeypatch, row(alertname="Watchdog", labels={"alertname": "Watchdog", "job": "node-exporter"}))
    assert none["rule_cards"] == []


# --- a chat turn --------------------------------------------------------------------------------------------------


async def chat_turn(monkeypatch, message, tool_names=("k8s_describe_resource", "prometheus_query"), audits=None):
    """One chat turn whose model answers at once: the messages it was sent (its audit rows into `audits` when given)."""
    from app.services.ai import streaming

    calls = []

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            pass

        async def get_messages(self, sid):
            return [SimpleNamespace(role="user", content=message)]

        async def get_context(self, sid):
            return None

        async def update_context(self, sid, **kw):
            pass

        async def update_session_title(self, sid, title):
            pass

    async def get_db_service():
        return DB()

    async def no_audit(**kw):
        if audits is not None:
            audits.append(kw)
        return True

    async def no_budget(*a, **kw):
        return None

    async def same_tools(tools, service):
        return tools

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", no_audit)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr("app.services.ai.features.gate_tools", same_tools)

    async def create(**kwargs):
        calls.append(json.loads(json.dumps(kwargs["messages"], default=str)))
        return stream([text_chunk("Read it.")])

    tools = [{"type": "function", "function": {"name": n, "parameters": {"type": "object", "properties": {}}}} for n in tool_names]
    service = SimpleNamespace(
        model="claude-haiku-5-5", provider="anthropic", user_role="admin", tier="default", cluster_name="self",
        client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))),
        tool_contexts={}, tool_server=SimpleNamespace(last_redacted=None),
        _sanitize_history_content=lambda role, content: content,
        _build_language_directive=lambda message: "Answer in English.",
        _get_tools_definition=lambda: tools,
        _filter_tools_for_output_preference=lambda tools, message: tools,
        _execute_function_with_context=None,
    )
    actor = {"user_id": "u1", "email": "dev@example.com"} if audits is not None else None
    events = parsed([e async for e in streaming.session_chat_stream(service, "s1", message, audit_actor=actor)])
    assert events[-1] == "[DONE]", events
    return calls[0]


@pytest.mark.asyncio
async def test_with_the_switch_off_a_chat_turn_is_sent_as_it_was(monkeypatch):
    monkeypatch.delenv("AI_RULE_CARDS_CHAT", raising=False)
    monkeypatch.setenv("AI_RULE_CARDS_INVESTIGATIONS", "true")  # the investigations' switch does not reach the chat
    sent = await chat_turn(monkeypatch, "why is web OOMKilled?")
    assert [m["role"] for m in sent] == ["system", "user", "system"]
    assert not any("Rule cards" in m["content"] for m in sent)


@pytest.mark.asyncio
async def test_with_the_switch_on_a_question_naming_a_failure_gets_its_card_for_that_turn(monkeypatch):
    monkeypatch.setenv("AI_RULE_CARDS_CHAT", "true")
    sent = await chat_turn(monkeypatch, "why is web OOMKilled?")
    assert [m["role"] for m in sent] == ["system", "user", "system", "system"]
    note = sent[-1]["content"]
    assert note.startswith("Rule cards, picked by the server from the failure the question names") and 'Card "oom"' in note
    assert "— k8s_describe_resource" in note and "— prometheus_query" in note and "timeline" not in note
    # a question naming no failure is sent as with the switch off
    sent = await chat_turn(monkeypatch, "how many pods are there?")
    assert [m["role"] for m in sent] == ["system", "user", "system"]


@pytest.mark.asyncio
async def test_the_chat_turns_row_names_the_kinds_of_its_cards_and_nothing_with_the_switch_off(monkeypatch):
    def complete(audits):
        return [a["after"] for a in audits if a["action"] == "ai.chat.complete"][0]

    monkeypatch.delenv("AI_RULE_CARDS_CHAT", raising=False)
    off = []
    await chat_turn(monkeypatch, "why is web OOMKilled?", audits=off)
    assert "rule_cards" not in complete(off)
    monkeypatch.setenv("AI_RULE_CARDS_CHAT", "true")
    on = []
    await chat_turn(monkeypatch, "why is web OOMKilled?", audits=on)
    assert complete(on)["rule_cards"] == ["oom"]
    assert set(complete(on)) - set(complete(off)) == {"rule_cards"}
    none = []
    await chat_turn(monkeypatch, "how many pods are there?", audits=none)
    assert complete(none)["rule_cards"] == []


def test_the_chat_note_follows_its_own_switch():
    tools = [{"function": {"name": "k8s_get_pod_logs"}}]
    on = rule_cards.Settings(chat=True, investigations=False, cards=DEFAULTS)
    note, kinds = rule_cards.chat_cards("pod is in CrashLoopBackOff", tools, on)
    assert 'Card "crash"' in note and kinds == ["crash"]
    assert rule_cards.chat_cards("pod is in CrashLoopBackOff", tools, rule_cards.Settings(investigations=True, cards=DEFAULTS)) == (None, None)
    assert rule_cards.chat_cards("pod is in CrashLoopBackOff", [], on) == (None, [])
