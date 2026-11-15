"""With every v0.7.9 switch off, the model is sent what 0.7.8 sent, to the byte: the chat's and the floating chat's
messages and tool definitions for a question in Korean, English and French (the system prompt, the language line, the
floating page masked with REDACTION_PII on), the MCP server's tool list, and a text masked with REDACTION_PII on. Each is
held as the sha256 of what the merge base of the v0.7.9 pull requests (main d58cf599, the prompt and tool files as in
0.7.8) sends; a switch's words that reach the model with the switch off change one of them."""
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
    "ALERT_INVESTIGATION_EVIDENCE_CHECK", "ALERT_INVESTIGATION_LEDGER",
)

# The cluster's features with every 0.7.8 feature on and none of 0.7.9's (anomalyRank, callGraph): the most tools 0.7.8 offered.
V078_FEATURES = {
    "prometheus": {"enabled": True}, "logSearch": {"enabled": True, "clusters": ["self"]}, "traceStore": {"enabled": True, "clusters": ["self"]},
    "alertStore": {"enabled": True, "clusters": ["self"]}, "networkFlows": {"enabled": True, "clusters": ["self"]},
    "networkFlowMonitor": {"enabled": True, "clusters": ["self"]}, "cost": {"enabled": True}, "policyReports": {"enabled": True},
    "alertInvestigation": {"enabled": True}, "logFiles": {"enabled": True},
}

QUESTIONS = {
    "ko": "shop 네임스페이스의 web 파드가 왜 계속 재시작해?",
    "en": "Why does the web pod in the shop namespace keep restarting?",
    "fr": "Pourquoi le pod web du namespace shop redémarre-t-il sans cesse ?",
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
    "chat messages ko": "8f0f0cfe81ea2fd30558060fad00877cb6b5ea8fe21ae62d06ab052775680495",
    "chat messages en": "a75991dc54b8868afdb27c46a5a4c587a83158c4ef0009ccfbcb6f873ba0a92f",
    "chat messages fr": "ec6434ff8a70c4f8e963b416699824483e200fe7384ff8c747d0e36dacf65bed",
    "chat tools": "bd30d62b2b4a61db2bc40a401cd6d62a57135cd6bd5477f6c8bed7531c485a94",
    "floating messages ko": "f5849117bd4ca78607344ef64b675c9ab4776483fa8174ca8207a3415dfffd84",
    "floating messages en": "19f47cdb4802dd3900124cba7141fc959a20bc82d6c140d94ef25369b2ec1315",
    "floating messages fr": "701db657ad26d32320afa7e171943ed0fa0d7b7c4b3a8196655f65db07ce4f9f",
    "floating tools": "9bcba9d81a94dd1ebf1e506e8cbd3fc16cb1d1b761c776c575041173187681d7",
    "mcp tools": "a9102a1ecc66e0eb023b45a2bc01bb57f9346ad1d5894112c1991a9f2de5cc16",
    "masked text": "c86dd3f61d49c68ed59dfa80c31c1c899ee5a57da982c402a989c432dde6d902",
}


def _sha(value) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return hashlib.sha256(text.encode()).hexdigest()


async def _first_call(monkeypatch, message, floating):
    """The messages and tools of the first model call of one chat turn (the floating chat's with the page above)."""
    from app.services.ai import features, streaming
    from app.services.ai.intent import filter_tools_for_output_preference
    from app.services.ai.language import build_language_directive
    from app.services.ai.tools import get_tools_definition
    from app.services.floating_ai_service import FloatingAIService
    from app.services.tool_server_client import ToolServerClient

    sent = []

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

    async def no_budget(*a, **kw):
        return None

    async def cluster_features(k8s_client, cluster):
        return json.loads(json.dumps(V078_FEATURES))

    monkeypatch.setattr("app.database.get_db_service", get_db_service)
    monkeypatch.setattr("app.services.audit_writer.write_audit", no_audit)
    monkeypatch.setattr(streaming.budget_mod, "check", no_budget)
    monkeypatch.setattr(features, "fetch_features", cluster_features)

    async def create(**kwargs):
        sent.append(json.loads(json.dumps({"messages": kwargs["messages"], "tools": kwargs.get("tools")}, default=str)))
        return stream([text_chunk("ok")])

    service = SimpleNamespace(
        model="claude-haiku-5-5", provider="anthropic", user_role="admin", tier="default", cluster_name="self", token=None,
        k8s_service=SimpleNamespace(), client=SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))),
        tool_contexts={}, tool_server=ToolServerClient(authorization="Bearer t"),
        _sanitize_history_content=lambda role, content: content, _build_language_directive=build_language_directive,
        _filter_tools_by_role=lambda tools: tools, _filter_tools_for_output_preference=filter_tools_for_output_preference,
        _execute_function_with_context=None,
    )
    service._get_tools_definition = lambda: get_tools_definition(service)
    service.session_chat_stream = lambda **kw: streaming.session_chat_stream(service, **kw)
    actor = {"user_id": "u1", "email": "u1@example.com"}
    if floating:
        turn = FloatingAIService(service).session_chat_stream(session_id="s1", message=message, page_context=PAGE, cluster_name="self", audit_actor=actor)
    else:
        turn = streaming.session_chat_stream(service, "s1", message, audit_actor=actor)
    events = parsed([e async for e in turn])
    assert events[-1] == "[DONE]", events
    features.clear_cache()
    return sent[0]


async def _what_the_model_reads(monkeypatch):
    from app import mcp_server
    from app.services import redact

    got = {}
    for floating, name in ((False, "chat"), (True, "floating")):
        for language, question in QUESTIONS.items():
            first = await _first_call(monkeypatch, question, floating)
            got[f"{name} messages {language}"] = _sha(first["messages"])
            got[f"{name} tools"] = _sha(first["tools"])
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
