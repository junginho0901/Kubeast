"""What the model is sent carries no credential and no value of the install it runs on, so a planted instruction that
asks the model to repeat its prompt or its tools gets none (threat model 2.3).

What counts as one:
- every key of the chart's Secret, which ai-service's environment holds: the model keys and the subscription token, the
  internal and webhook tokens, the approval key, the database address with its password, the Redis passwords, the OIDC
  client key and the first admin password;
- the addresses of the install's own services and stores (auth-service, tool-server, the model endpoint, the metrics, log,
  trace and alert stores, Argo CD, OIDC, the console's own address, the allowed model and store hosts), the kubeconfig
  path and the CA directory;
- the pod's own names: its host name, its namespace and the Kubernetes API server's address;
- per request: the investigator's token, the model's address, key and headers on the service, and the signed-in person's
  ID and email.
Each is set below to a made-up value holding OWN; no model call holds OWN or any of SHAPES (a web or database address,
an IPv4 address, an in-cluster service name, a bearer token, a JWT, a PEM block, a model or cloud key).

Named on purpose, so not in the list: the cluster and namespace the request is about (the person picked them, or the
alert did), what the cluster or the alert wrote, which reaches the model fenced as data and masked
(test_planted_values.py), and the rule's expression in the alert's link, whose address (PROMETHEUS_URL) stays out
(test_alert_rule_expression.py)."""
import json
import re
from types import SimpleNamespace
from urllib.parse import quote_plus

import pytest

from app.config import settings as app_settings
from app.models.floating_ai import PageContextPayload, VisibleDataLayer
from app.prompts.floating_system_prompt import build_floating_system_prompt
from app.security import TokenPayload
from app.services.ai import prompts
from app.services.ai import tools as catalog
from app.services.ai.language import build_language_directive
from app.services.floating_ai_service import FloatingAIService
from app.services.investigation import runner
from app.services.investigation import settings as inv_settings
from app.services.tool_whitelists import READONLY_TOOL_NAMES
from tests.test_alert_investigation import completion, install_loop, row, tool_call
from tests.test_chat_turn_edges import parsed, stream, text_chunk
from tests.test_investigation_narrowing import NarrowService, anomaly_rank_on
from tests.test_investigation_window import STARTED, at_now, step_zero_reads
from tests.test_planted_values import chat_rig

OWN = "ownvalue"

# The environment ai-service runs with (the chart's Secret and ConfigMap, the pod), by variable.
INSTALL_ENV = {
    "OPENAI_API_KEY": "sk-ownvalue-openai-0001",
    "ANTHROPIC_API_KEY": "sk-ant-ownvalue-anthropic-0002",
    "GEMINI_API_KEY": "ownvalue-gemini-0003",
    "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-ownvalue-0004",
    "INTERNAL_API_TOKEN": "ownvalue-internal-token-0005",
    "ALERT_WEBHOOK_TOKEN": "ownvalue-webhook-token-0006",
    "AI_APPROVAL_SECRET": "ownvalue-approval-key-0007",
    "DATABASE_URL": "postgresql://kubeast:ownvalue-db-pass-0008@ownvalue-db.ownvalue-ns.svc:5432/kubeast",
    "POSTGRES_PASSWORD": "ownvalue-db-pass-0008",
    "REDIS_PASSWORD": "ownvalue-redis-pass-0009",
    "REDIS_K8S_SERVICE_PASSWORD": "ownvalue-redis-pass-0010",
    "REDIS_TOOL_SERVER_PASSWORD": "ownvalue-redis-pass-0011",
    "REDIS_PROBE_PASSWORD": "ownvalue-redis-pass-0012",
    "OIDC_CLIENT_SECRET": "ownvalue-oidc-client-0013",
    "DEFAULT_ADMIN_PASSWORD": "ownvalue-admin-pass-0014",
    "AUTH_SERVICE_URL": "http://ownvalue-auth.ownvalue-ns.svc:8004",
    "AUTH_JWKS_URL": "http://ownvalue-auth.ownvalue-ns.svc:8004/api/v1/auth/jwks.json",
    "AUTH_TOKEN_VERSION_URL": "http://ownvalue-auth.ownvalue-ns.svc:8004/api/v1/auth/internal/token-version",
    "AUTH_INVESTIGATOR_TOKEN_URL": "http://ownvalue-auth.ownvalue-ns.svc:8004/api/v1/auth/internal/investigator-token",
    "TOOL_SERVER_URL": "http://ownvalue-tools.ownvalue-ns.svc:8086",
    "TOOL_SERVER_URL_READ": "http://ownvalue-tools-read.ownvalue-ns.svc:8086",
    "TOOL_SERVER_URL_WRITE": "http://ownvalue-tools-write.ownvalue-ns.svc:8086",
    "TOOL_SERVER_URL_ADMIN": "http://ownvalue-tools-admin.ownvalue-ns.svc:8086",
    "OPENAI_BASE_URL": "https://ownvalue-models.example.com/v1",
    "AI_BASE_URL_ALLOWED_HOSTS": "ownvalue-models.example.com",
    "PROMETHEUS_URL": "http://ownvalue-prometheus.monitoring.svc:9090",
    "LOG_SEARCH_URL": "http://ownvalue-loki.monitoring.svc:3100",
    "TRACE_STORE_URL": "http://ownvalue-tempo.monitoring.svc:3200",
    "ALERT_STORE_URL": "http://ownvalue-alertmanager.monitoring.svc:9093",
    "CLUSTER_STORE_ALLOWED_HOSTS": "ownvalue-stores.example.com",
    "GITOPS_ARGOCD_URL": "https://ownvalue-argocd.example.com",
    "OIDC_ISSUER_URL": "https://ownvalue-sso.example.com/realms/ownvalue",
    "ALERT_INVESTIGATION_CONSOLE_URL": "https://ownvalue-console.example.com",
    "KUBECONFIG_PATH": "/etc/ownvalue/kubeconfig",
    "CUSTOM_CA_DIR": "/etc/ownvalue-ca",
    "HOSTNAME": "ai-service-ownvalue-7d9f6",
    "POD_NAMESPACE": "ownvalue-ns",
    "KUBERNETES_SERVICE_HOST": "10.250.50.1",
}

# What a request holds: the investigator's token, the model service as built from its config, the person signed in.
PER_REQUEST = {
    "investigator token": "ownvalue-investigator-token-0101",
    "model address": "https://ownvalue-models.example.com/v1",
    "model key": "sk-ownvalue-model-key-0102",
    "model header": "ownvalue-model-header-0103",
    "person ID": "ownvalue-person-0104",
    "person email": "ownvalue.person@example.com",
}

# The alert's link as Prometheus writes it: the install's metrics address, then the rule's expression.
RULE = 'increase(kube_pod_container_status_restarts_total{namespace="apps"}[10m]) > 3'
ALERT_LINK = f"{INSTALL_ENV['PROMETHEUS_URL']}/graph?g0.expr={quote_plus(RULE)}&g0.tab=1"

SHAPES = {
    "web address": r"https?://",
    "database address": r"\b(?:postgres(?:ql)?|rediss?|mysql|mongodb)(?:\+\w+)?://",
    "IPv4 address": r"\b\d{1,3}(?:\.\d{1,3}){3}\b",
    "in-cluster service name": r"\.svc\b|\bcluster\.local\b",
    "bearer token": r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}",
    "JWT": r"\beyJ[A-Za-z0-9_-]{8,}\.",
    "PEM block": r"-----BEGIN [A-Z ]+-----",
    "model key": r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}",
    "cloud key": r"\bAKIA[0-9A-Z]{16}\b",
}

# The switches that add words to the prompts, all on.
INVESTIGATION_SWITCHES = (
    "ALERT_INVESTIGATION_ENABLED", "ALERT_INVESTIGATION_RULES", "ALERT_INVESTIGATION_CHANGES_FIRST",
    "ALERT_INVESTIGATION_NARROW_FIRST", "ALERT_INVESTIGATION_LEDGER", "ALERT_INVESTIGATION_EVIDENCE_CHECK",
    "ALERT_INVESTIGATION_VERDICT",
    "CALL_GRAPH_ENABLED", "AI_TIMELINE_CHANGES", "AI_TIMELINE_CHANGES_MORE", "AI_RULE_CARDS_INVESTIGATIONS", "AI_RULE_CARDS_SYMPTOMS",
    "AI_TOOL_RESULT_DETAILS", "NODE_NEIGHBORS_ENABLED", "AI_FAULT_ONSET",
)
CHAT_SWITCHES = ("AI_TIMELINE_CHANGES", "AI_TIMELINE_CHANGES_MORE", "ANOMALY_RANK_ENABLED", "CALL_GRAPH_ENABLED", "AI_RULE_CARDS_CHAT",
                 "AI_TOOL_RESULT_DETAILS", "AI_CAUSE_QUESTIONS", "AI_RULE_CARDS_SYMPTOMS",
                 "NODE_NEIGHBORS_ENABLED", "AI_FAULT_ONSET")


def found(text: str) -> list[str]:
    """The made-up values and the shapes in text, by name."""
    named = [name for name, value in {**INSTALL_ENV, **PER_REQUEST}.items() if value in text]
    part = [f"part of a made-up value ({OWN})"] if OWN in text and not named else []
    return named + part + [name for name, shape in SHAPES.items() if re.search(shape, text)]


def sent_text(calls) -> str:
    """What the model calls were sent: their messages and tools."""
    return json.dumps([{"messages": c.get("messages"), "tools": c.get("tools")} for c in calls], ensure_ascii=False, default=str)


def all_tools():
    return catalog.get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda tools: tools))


def plant(monkeypatch):
    """The made-up values where ai-service reads them: its environment and its settings."""
    for name, value in INSTALL_ENV.items():
        monkeypatch.setenv(name, value)
    for name in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "KUBECONFIG_PATH"):
        monkeypatch.setattr(app_settings, name, INSTALL_ENV[name], raising=False)

    async def no_database():  # audit_ready asks it; a sqlite address opens no connection
        return SimpleNamespace(database_url="sqlite+aiosqlite://")

    monkeypatch.setattr("app.database.get_db_service", no_database)


def test_the_check_finds_every_made_up_value_and_shape():
    for name, value in {**INSTALL_ENV, **PER_REQUEST}.items():
        assert found(f"a {value} b"), name
    samples = {"web address": "at http://x", "database address": "redis://r:6379", "IPv4 address": "10.0.0.1",
               "in-cluster service name": "auth.kubeast.svc", "bearer token": "Bearer abcdefgh1234",
               "JWT": "eyJhbGciOiJIUzI1NiJ9.e30.x", "PEM block": "-----BEGIN PRIVATE KEY-----",
               "model key": "sk-ant-abcdefgh1234", "cloud key": "AKIAABCDEFGHIJKLMNOP"}
    assert sorted(samples) == sorted(SHAPES)
    for name, sample in samples.items():
        assert name in found(sample), name
    assert found("the namespace \"apps\" of cluster \"self\", disk-pressure, task-runner, 1.30.2") == []


class InstallService(NarrowService):
    """Answers timeline and anomaly_rank (step 0), offers the tool catalog as the model is offered it and holds what a
    built service holds: the model's address, key and headers."""

    def __init__(self, replies):
        super().__init__(replies)
        self.base_url, self.api_key = PER_REQUEST["model address"], PER_REQUEST["model key"]
        self.extra_headers = {"Authorization": PER_REQUEST["model header"]}

    def _get_tools_definition(self):
        return all_tools()


@pytest.mark.asyncio
async def test_an_investigation_with_every_step_on_sends_no_value_of_the_install(monkeypatch):
    plant(monkeypatch)
    for name in INVESTIGATION_SWITCHES:
        monkeypatch.setenv(name, "true")
    monkeypatch.setenv("ALERT_INVESTIGATION_MAX_STEPS", "5")
    anomaly_rank_on(monkeypatch)
    settings = inv_settings.load()  # as the worker reads it
    assert all((settings.rules, settings.changes_first, settings.narrow_first, settings.ledger, settings.evidence_check,
                settings.verdict, settings.call_paths))
    assert settings.internal_token == INSTALL_ENV["INTERNAL_API_TOKEN"]
    assert settings.console_url == INSTALL_ENV["ALERT_INVESTIGATION_CONSOLE_URL"]
    service = InstallService([
        completion(calls=[tool_call("c1", "k8s_get_resources", {"resource_type": "pods", "namespace": "apps"})]),
        completion(content="## Summary\nweb-1 restarts."),  # no rca block: asked once more
        completion(content="## Summary\nweb-1 restarts since the image changed."),
    ])
    install_loop(monkeypatch, service, [])

    async def token(cfg, cluster, namespace):
        return PER_REQUEST["investigator token"]

    monkeypatch.setattr(runner, "fetch_token", token)
    at_now(monkeypatch)
    labels = {"alertname": "KubePodCrashLooping", "namespace": "apps", "pod": "web-1", "severity": "critical"}
    await runner.investigate(settings, row(starts_at=STARTED, labels=labels, annotations={"summary": "web-1 restarts"},
                                           generator_url=ALERT_LINK))

    calls = service.completions.calls
    system, first = calls[0]["messages"][0]["content"], calls[0]["messages"][1]["content"]
    # every part an investigation sends: the rules, step 0's two reads, the rule cards, a tool result and the second ask
    assert len(calls) == 3 and calls[0]["tools"]
    assert "Step 0: the server called timeline" in first and "Step 0: the server called anomaly_rank" in first
    assert "<<<CHANGES" not in first and "<<<NARROWING" not in first and "Rule cards, picked by the server" in first
    # step 0's answers: the tool messages right after the first message (tool_turn.server_calls)
    reads, answers = step_zero_reads(service)
    assert [name for name, _ in reads] == ["timeline", "anomaly_rank"] and all(answers)
    assert any(isinstance(m, dict) and m.get("role") == "tool" for m in calls[1]["messages"])
    # named on purpose: the alert's cluster and namespace
    assert 'the namespace "apps" of cluster "self"' in system and first.startswith("Cluster: self\n")
    assert f'"expr": {json.dumps(RULE)}' in first  # and the rule's expression, without the link's address
    assert found(sent_text(calls)) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("floating", [False, True], ids=["ai-chat", "floating-chat"])
async def test_a_chat_turn_sends_no_value_of_the_install(monkeypatch, floating):
    plant(monkeypatch)
    for name in CHAT_SWITCHES:
        monkeypatch.setenv(name, "true")
    question = "why is web-1 in CrashLoopBackOff?"
    service, _, _ = chat_rig(monkeypatch, [SimpleNamespace(role="user", content=question)], [])
    sent = []

    async def create(**kw):
        sent.append(kw)
        return stream([text_chunk("Read it.")])

    service.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    service._build_language_directive = build_language_directive
    service._get_tools_definition = all_tools
    service.base_url, service.api_key = PER_REQUEST["model address"], PER_REQUEST["model key"]
    service.extra_headers = {"Authorization": PER_REQUEST["model header"]}
    # a Read role: the chat names what it may not do there
    service.token = TokenPayload(user_id=PER_REQUEST["person ID"], role="member", email=PER_REQUEST["person email"],
                                 matrix={"self": ("resource.*.read", *(f"ai.tool.{n}" for n in sorted(READONLY_TOOL_NAMES)))})
    if floating:
        shown = VisibleDataLayer(source="base", summary="pod", data={"name": "web-1", "status": "CrashLoopBackOff"})
        page = PageContextPayload(page_type="resource-detail", page_title="web-1", path="/workloads/pods",
                                  snapshot_at="2026-11-19T00:00:00Z", base=shown)
        floating_chat = FloatingAIService(service)
        events = [e async for e in floating_chat.session_chat_stream("s1", question, page_context=page, cluster_name="self")]
    else:
        events = [e async for e in service.session_chat_stream(session_id="s1", message=question)]

    assert parsed(events)[-1] == "[DONE]" and sent and sent[0]["tools"]
    text = sent_text(sent)
    assert sent[0]["messages"][0]["content"] == (build_floating_system_prompt() if floating else prompts.system_message())
    assert "LANGUAGE OVERRIDE" in text and "Rule cards, picked by the server" in text
    # named on purpose: the cluster the person picked, on the page or in what the role may not do there
    assert ("- 클러스터: self" if floating else "This user's role in cluster self") in text
    assert found(text) == []
