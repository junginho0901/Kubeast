"""With every v0.7.9 switch off, the model is sent what 0.7.8 sent, to the byte: the chat's and the floating chat's
messages and tool definitions for a question in Korean, English and French (the system prompt, the language line, the
floating page masked with REDACTION_PII on), the chat's and an alert investigation's calls around one round of tools (ROUND)
and what they ask tool-server, the MCP server's tool list, and a text masked with REDACTION_PII on. Each is held as the
sha256 of what the merge base of the v0.7.9 pull requests (main d58cf599, the prompt and tool files as in 0.7.8) sends; a
switch's words that reach the model with the switch off change one of them.
Tool results are held for ROUND's stand-in answers only: AI_TOOL_RESULTS_JSON's off path for the other results is held by
its own pull request's tests (#920), tool-server's answers by v079_round_answers_test.go."""
import hashlib
import json
from types import SimpleNamespace

import pytest

from app.models.floating_ai import PageContextPayload, VisibleDataLayer
from tests.test_chat_turn_edges import parsed, stream, text_chunk

# Every v0.7.9 switch, as the chart's ConfigMap names it; each is off when unset (LOG_SEARCH_QUERY_MAX_BYTES: 0, not asked).
V079_SWITCHES = (
    "AI_TIMELINE_CHANGES", "ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED", "AI_RULE_CARDS_CHAT", "AI_RULE_CARDS_INVESTIGATIONS",
    "AI_REFUSE_REPEATED_READS", "AI_TOOL_RESULT_DETAILS", "REDACTION_NUMBERED", "LOG_SEARCH_QUERY_MAX_BYTES",
    "ALERT_INVESTIGATION_RULES", "ALERT_INVESTIGATION_CHANGES_FIRST", "ALERT_INVESTIGATION_NARROW_FIRST",
    "ALERT_INVESTIGATION_EVIDENCE_CHECK", "ALERT_INVESTIGATION_LEDGER", "AI_TOOL_RESULTS_JSON",
)

# The cluster's features with every 0.7.8 feature on and none of 0.7.9's (anomalyRank, callGraph): the most tools 0.7.8 offered.
V078_FEATURES = {
    "prometheus": {"enabled": True}, "logSearch": {"enabled": True, "clusters": ["self"]}, "traceStore": {"enabled": True, "clusters": ["self"]},
    "alertStore": {"enabled": True, "clusters": ["self"]}, "networkFlows": {"enabled": True, "clusters": ["self"]},
    "networkFlowMonitor": {"enabled": True, "clusters": ["self"]}, "cost": {"enabled": True}, "policyReports": {"enabled": True},
    "alertInvestigation": {"enabled": True}, "logFiles": {"enabled": True},
}

# Each names a failure, which picks a rule card where the chat's rule cards are on.
QUESTIONS = {
    "ko": "shop 네임스페이스의 web 파드가 OOMKilled로 계속 재시작해. 왜 깨졌어?",
    "en": "Why does the web pod in the shop namespace keep restarting with OOMKilled?",
    "fr": "Pourquoi le pod web du namespace shop redémarre-t-il sans cesse (OOMKilled) ?",
}

PAGE = PageContextPayload(
    page_type="resource-list", page_title="Pods", path="/workloads/pods", namespace="shop", snapshot_at="2026-11-15T00:00:00Z",
    base=VisibleDataLayer(source="base", summary="3 pods", data={"rows": [
        {"name": "web-1", "owner": "ann@example.com", "oncall": "010-1234-5678", "card": "4111-1111-1111-1111"},
        {"name": "web-2", "owner": "Ann@Example.com", "note": "ann@example.com paged <EMAIL_3> and 010-1234-5678"},
    ]}),
)

MASKED = ("login ann@example.com Ann@Example.com bob@example.com phone 010-1234-5678 rrn 900101-1234567 "
          "card 4111-1111-1111-1111 earlier <EMAIL_4> <PHONE_2>\npassword: <PHONE_1>\nAuthorization: Bearer abcdefghijklmnop0123\n")

# sha256 of each of the above as main d58cf599 sends it (hashes of the JSON written with ensure_ascii=False).
V078 = {
    "chat messages ko": "68afb98f58f0de1cb0963997038a0e43454ed72926242e88e6bb268fac0bd3dd",
    "chat messages en": "1573903a24b67517dea7a7ed6d583c6a3a0efbf03c3e97e5aab8bedc9464a9b9",
    "chat messages fr": "ddd7c0bb24893979dd3a537a96af44d7b39237c08d434820bcf3bc040ced91e6",
    "chat tools": "bd30d62b2b4a61db2bc40a401cd6d62a57135cd6bd5477f6c8bed7531c485a94",
    "floating messages ko": "72ae8d680f5caf53d35fc463ac21fc00fbe2bfb862d9e202ab5940e17cea05b6",
    "floating messages en": "3153b3ab1f4e83b603108a1386ed83b2d5d2591d2f2d6e45d0af1ad21ccbcf4e",
    "floating messages fr": "82a9a4b1c4dce0d7aff16e9c9ef3dd9afd885a08dfc02614ee27014ed6c79e5e",
    "floating tools": "9bcba9d81a94dd1ebf1e506e8cbd3fc16cb1d1b761c776c575041173187681d7",
    "chat second call": "c58e7c62a59a34b888ecf2a60cb33e996641212e3b8ad4c4df185c2cc2b48793",
    "chat tool-server calls": "5d8da759a4d9aa10e638da55a396fda8b9dea31db8206d81ca9947db3e503c85",
    # Not d58cf599's, on purpose with no switch: the alert leaves out its generatorURL, the address of the server that
    # sent it, and keeps only the rule's expression (none in this alert). With "generatorURL": "" put back in the alert
    # view they are d58cf599's 7e132b9533a49709… and c0724a074ee83bca….
    "investigation first call": "bcb5a605f558f79ceea73569bb0ddaa1b4c45f7b766850bade468388435ebaff",
    "investigation second call": "50f74919d9a129dc3d7ede28102b1590ba9b5cc69a7ab452ff266be9cc39093b",
    "investigation tool-server calls": "5d8da759a4d9aa10e638da55a396fda8b9dea31db8206d81ca9947db3e503c85",
    "mcp tools": "a9102a1ecc66e0eb023b45a2bc01bb57f9346ad1d5894112c1991a9f2de5cc16",
    "masked text": "c86dd3f61d49c68ed59dfa80c31c1c899ee5a57da982c402a989c432dde6d902",
}


def _sha(value, sort_keys=False) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str, sort_keys=sort_keys)
    return hashlib.sha256(text.encode()).hexdigest()


# One round of tools the model asks for: the v0.7.9 arguments (timeline's view, resource_graph's calls, anomaly_rank)
# and two tools whose results v0.7.9 shapes (a LogQL metric query, a pod's log). tool-server is stood in by TOOL_ANSWERS.
ROUND = [
    ("timeline", {"namespace": "shop", "view": "changes", "since_time": "2026-11-15T00:00:00Z", "until_time": "2026-11-15T04:00:00Z"}),
    ("resource_graph", {"namespace": "shop", "include": ["calls"], "since": "1h", "since_time": "2026-11-15T03:00:00Z"}),
    ("anomaly_rank", {"namespace": "shop"}),
    ("loki_query", {"logql": "sum by (pod) (count_over_time({namespace=\"shop\"} |= \"error\" [5m]))", "namespace": "shop", "since": "1h", "step": 300}),
    ("k8s_get_pod_logs", {"pod_name": "web-1", "namespace": "shop", "container": "app", "tail_lines": 20}),
]
TOOL_ANSWERS = {
    "timeline": {"namespace": "shop", "summary": {"events_total": 2, "rollouts_total": 1}, "events": [
        {"type": "Warning", "reason": "BackOff", "object": "Pod/web-1", "message": "Back-off restarting failed container app",
         "first_timestamp": "2026-11-15T03:50:00Z", "last_timestamp": "2026-11-15T03:58:00Z", "count": 7}],
        "rollouts": [{"kind": "Deployment", "name": "web", "revision": 4, "created": "2026-11-15T03:40:00Z"}]},
    "resource_graph": {"summary": {"nodes": 2, "edges": 1}, "nodes": [{"id": "Deployment/web", "kind": "Deployment", "name": "web"},
                       {"id": "Service/web", "kind": "Service", "name": "web"}], "edges": [{"from": "Service/web", "to": "Deployment/web", "type": "selector"}]},
    "loki_query": {"resultType": "matrix", "result": [{"metric": {"pod": "web-1"}, "values": [[1763178000, "12"], [1763178300, "30"]]}],
                   "seriesTotal": 1, "effectiveQuery": "sum by (pod) (count_over_time({namespace=\"shop\"} |= \"error\" [5m]))"},
    "k8s_get_pod_logs": "2026-11-15T03:58:01Z ERROR java.lang.OutOfMemoryError: Java heap space\n2026-11-15T03:58:02Z INFO shutting down\n",
}


def _calls_chunk(calls):
    tcs = [SimpleNamespace(index=i, id=f"call_{i + 1}", function=SimpleNamespace(name=name, arguments=json.dumps(args)))
           for i, (name, args) in enumerate(calls)]
    delta = SimpleNamespace(content=None, tool_calls=tcs)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason="tool_calls")], usage=None)


def _service(monkeypatch, create, asked):
    """A chat service over the real tool catalogue, dispatch and features gate; the model and tool-server stood in."""
    from app.services.ai import features
    from app.services.ai.intent import filter_tools_for_output_preference
    from app.services.ai.language import build_language_directive
    from app.services.ai.tool_dispatch import execute_function_with_context
    from app.services.ai.tools import get_tools_definition
    from app.services.tool_server_client import ToolServerClient

    async def cluster_features(k8s_client, cluster):
        return json.loads(json.dumps(V078_FEATURES))

    monkeypatch.setattr(features, "fetch_features", cluster_features)

    async def call_tool_server(name, args, approval_id=None, approval_token=None):
        asked.append([name, args])
        answer = TOOL_ANSWERS.get(name, {"status": "ok"})
        return answer if isinstance(answer, str) else json.dumps(answer)

    service = SimpleNamespace(
        model="claude-haiku-5-5", provider="anthropic", user_role="admin", tier="default", cluster_name="self", token=None,
        k8s_service=SimpleNamespace(), client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))),
        tool_contexts={}, tool_server=ToolServerClient(authorization="Bearer t"),
        _sanitize_history_content=lambda role, content: content, _build_language_directive=build_language_directive,
        _filter_tools_by_role=lambda tools: tools, _filter_tools_for_output_preference=filter_tools_for_output_preference,
        _is_tool_allowed=lambda name: True, _call_tool_server=call_tool_server,
    )
    service._get_tools_definition = lambda: get_tools_definition(service)
    service._execute_function_with_context = lambda name, args, ctx: execute_function_with_context(service, name, args, ctx)
    service.session_chat_stream = lambda **kw: streaming_session(service, **kw)
    return service


def streaming_session(service, **kw):
    from app.services.ai import streaming
    return streaming.session_chat_stream(service, **kw)


async def _chat_calls(monkeypatch, message, floating, round_=None):
    """The model calls of one chat turn (the floating chat's with the page above): with round_, the model first asks for
    those tools, and the second call reads their results. Returns the calls and what tool-server was asked."""
    from app.services.ai import features, streaming
    from app.services.floating_ai_service import FloatingAIService

    sent, asked = [], []
    replies = ([stream([_calls_chunk(round_)])] if round_ else []) + [stream([text_chunk("ok")])]

    class DB:
        async def get_session(self, sid):
            return SimpleNamespace(id=sid, user_id="u1")

        async def add_message(self, sid, role, content, **kw):
            return SimpleNamespace(id=2)

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
        return True

    async def audit_ready():
        return True, None

    async def no_budget(*a, **kw):
        return None

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", no_audit)
    monkeypatch.setattr("app.services.audit_writer.audit_ready", audit_ready)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)

    async def create(**kwargs):
        sent.append(json.loads(json.dumps({"messages": kwargs["messages"], "tools": kwargs.get("tools")}, default=str)))
        return replies.pop(0)

    service = _service(monkeypatch, create, asked)
    actor = {"user_id": "u1", "email": "u1@example.com"}
    if floating:
        turn = FloatingAIService(service).session_chat_stream(session_id="s1", message=message, page_context=PAGE, cluster_name="self", audit_actor=actor)
    else:
        turn = streaming.session_chat_stream(service, "s1", message, audit_actor=actor)
    events = parsed([e async for e in turn])
    assert events[-1] == "[DONE]", events
    features.clear_cache()
    return sent, asked


async def _first_call(monkeypatch, message, floating):
    """The messages and tools of the first model call of one chat turn (the floating chat's with the page above)."""
    sent, _ = await _chat_calls(monkeypatch, message, floating)
    return sent[0]


async def _investigation_calls(monkeypatch):
    """The first two model calls of an alert investigation (the second after ROUND) and what tool-server was asked."""
    import dataclasses

    from app.services.investigation import runner
    from app.services.investigation import settings as inv_settings
    from tests.test_alert_investigation import FakeCompletions, completion, row, tool_call

    class AsSent(FakeCompletions):
        """Each call as it was sent: the runner goes on adding to the messages list it passed."""

        async def create(self, **kw):
            return await super().create(**json.loads(json.dumps(kw, default=str)))

    asked = []
    # anomaly_rank too: 0.7.8's investigator refuses it as a tool outside its read-only list
    completions = AsSent([completion(calls=[tool_call(f"c{i + 1}", n, a) for i, (n, a) in enumerate(ROUND)]),
                                   completion(content="## Summary\nok")])
    service = _service(monkeypatch, completions.create, asked)

    async def token(c, cluster, ns):
        return "investigator-token"

    async def build(c, t, cluster):
        return service

    async def audit(**kw):
        return True

    async def audit_ready():
        return True, None

    monkeypatch.setattr(runner, "fetch_token", token)
    monkeypatch.setattr(runner, "build_service", build)
    monkeypatch.setattr(runner, "write_audit", audit)
    monkeypatch.setattr(runner, "audit_ready", audit_ready)
    alert = row(namespace="shop", labels={"alertname": "KubePodCrashLooping", "namespace": "shop", "pod": "web-1", "owner": "ann@example.com"},
                annotations={"summary": "web-1 restarts", "oncall": "010-1234-5678"})
    # the settings as the environment gives them, so a v0.7.9 setting that defaults to on changes what is pinned
    await runner.investigate(dataclasses.replace(inv_settings.load(), max_steps=3), alert)
    from app.services.ai import features
    features.clear_cache()
    calls = [{"messages": c["messages"], "tools": c.get("tools"), "max_tokens": c.get("max_tokens")} for c in completions.calls]
    return json.loads(json.dumps(calls, default=str)), asked


async def _what_the_model_reads(monkeypatch):
    from app import mcp_server
    from app.services import redact

    got = {}
    for floating, name in ((False, "chat"), (True, "floating")):
        for language, question in QUESTIONS.items():
            first = await _first_call(monkeypatch, question, floating)
            got[f"{name} messages {language}"] = _sha(first["messages"])
            got[f"{name} tools"] = _sha(first["tools"])
    sent, asked = await _chat_calls(monkeypatch, QUESTIONS["en"], False, ROUND)
    got["chat second call"] = _sha(sent[1]["messages"])
    got["chat tool-server calls"] = _sha(asked, sort_keys=True)  # dispatch builds the arguments from sets
    calls, asked = await _investigation_calls(monkeypatch)
    got["investigation first call"] = _sha(calls[0])
    got["investigation second call"] = _sha(calls[1]["messages"])
    got["investigation tool-server calls"] = _sha(asked, sort_keys=True)
    reads = mcp_server._read_tools()
    got["mcp tools"] = _sha([[name, tool.model_dump(mode="json")] for name, tool in reads.items()])
    got["masked text"] = _sha(redact.redact_text(MASKED, redact.from_env())[0])
    return got


@pytest.mark.asyncio
async def test_with_every_v079_switch_off_the_model_is_sent_what_v078_sent(monkeypatch):
    for name in V079_SWITCHES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("REDACTION_PII", "true")  # a 0.7.8 switch: the masking the model reads with it on
    got = await _what_the_model_reads(monkeypatch)
    assert got == V078


@pytest.mark.asyncio
async def test_with_only_the_investigations_switches_on_a_chat_is_sent_and_asks_what_v078_did(monkeypatch):
    """Alert investigations with each of their v0.7.9 steps on: a chat's round is v0.7.8's (its tools, its second call,
    what it asks tool-server)."""
    for name in V079_SWITCHES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("REDACTION_PII", "true")
    for name in ("ALERT_INVESTIGATION_ENABLED", "ALERT_INVESTIGATION_CHANGES_FIRST", "ALERT_INVESTIGATION_NARROW_FIRST",
                 "ALERT_INVESTIGATION_EVIDENCE_CHECK", "ALERT_INVESTIGATION_LEDGER", "ALERT_INVESTIGATION_RULES",
                 "AI_RULE_CARDS_INVESTIGATIONS"):
        monkeypatch.setenv(name, "true")
    sent, asked = await _chat_calls(monkeypatch, QUESTIONS["en"], False, ROUND)
    got = {"chat tools": _sha(sent[0]["tools"]), "chat second call": _sha(sent[1]["messages"]),
           "chat tool-server calls": _sha(asked, sort_keys=True)}
    assert got == {name: V078[name] for name in got}
