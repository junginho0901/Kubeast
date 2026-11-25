"""The model config chosen for a use (app/services/model_uses.py): nothing chosen selects exactly what was selected
before, and a choice is followed, refused or given up as the module says."""
import asyncio
import dataclasses
import itertools
import time
from datetime import timedelta
from types import SimpleNamespace

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app import api, api_alert_inbox, security
from app.database import DatabaseService
from app.services import audit_writer, model_config_service as mcs, model_uses
from app.services.investigation import runner, store, webhook
from app.services.investigation import settings as inv_settings
from app.services.investigation.settings import InvestigationSettings
from main import app
from tests.test_alert_investigation import NOW, alert, am_message, row as alert_row

ROUTE = "/api/v1/ai/model-configs/uses"


@pytest.fixture
async def db(tmp_path, monkeypatch):
    """A database of its own, read by the services too; the key every config here names is set."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    for name in ("ALERT_INVESTIGATION_ENABLED", "ALERT_INVESTIGATION_MODEL", "ALERT_INVESTIGATION_MANUAL", "ALERT_INVESTIGATION_AUTOMATIC",
                 "KUBEAST_AI_KEY_STRONG"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(mcs.settings, "OPENAI_API_KEY", "", raising=False)
    service = DatabaseService(f"sqlite+aiosqlite:///{tmp_path}/uses.db")
    await service.init_db()

    async def get():
        return service

    for module in ("app.services.model_config_service", "app.services.investigation.runner", "app.database"):
        monkeypatch.setattr(f"{module}.get_db_service", get)
    api._invalidate_caches()
    yield service
    api._invalidate_caches()
    await service.engine.dispose()


async def add(db, name, **kw):
    return await db.create_model_config({"name": name, "provider": "openai", "model": f"{name}-model", "api_key_env": "OPENAI_API_KEY", **kw})


# ---- nothing chosen: as before ----


@pytest.mark.asyncio
async def test_nothing_chosen_is_the_settings_object_itself_for_both_kinds_of_investigation(db):
    await add(db, "chat", is_default=True)
    await add(db, "strong")
    for cfg in (InvestigationSettings(enabled=True), InvestigationSettings(enabled=True, model="strong")):
        assert await model_uses.run_settings(db, cfg, SimpleNamespace(requested_by="")) is cfg
        assert await model_uses.run_settings(db, cfg, SimpleNamespace(requested_by="ann@example.com")) is cfg


@pytest.mark.asyncio
async def test_nothing_chosen_the_run_resolves_the_config_with_the_same_call_as_before(db, monkeypatch):
    """build_service asks for the active config with no argument, or for the chart's by its id; nothing else is asked."""
    chat = await add(db, "chat", is_default=True)
    strong = await add(db, "strong")
    asked = []
    real = mcs.resolve_model_config

    async def resolve(*args, **kwargs):
        asked.append((args, kwargs))
        return await real(*args, **kwargs)

    monkeypatch.setattr(mcs, "resolve_model_config", resolve)
    row = SimpleNamespace(requested_by="")
    for cfg, call, model in ((InvestigationSettings(), ((), {}), chat.model),
                             (InvestigationSettings(model="strong"), ((), {"config_id": strong.id}), strong.model)):
        service = await runner.build_service(await model_uses.run_settings(db, cfg, row), "token", "self")
        assert asked.pop() == call and not asked and service.model == model


@pytest.mark.asyncio
async def test_nothing_chosen_the_optimization_runs_on_the_chats_own_client(db):
    await add(db, "chat", is_default=True)
    chat = await api._build_ai_service("Bearer t", cluster_name="self")
    optimization = await api._build_ai_service("Bearer t", cluster_name="self", use="optimization")
    assert optimization.client is chat.client
    assert (optimization.model, optimization.tier, optimization.provider) == (chat.model, chat.tier, chat.provider)
    assert optimization.summary_client is chat.summary_client and api._cached_use_services == {}


@pytest.mark.asyncio
async def test_nothing_chosen_used_for_says_what_it_said(db, monkeypatch):
    chat = await add(db, "chat", is_default=True)
    small = await add(db, "small", tier="economy")
    strong = await add(db, "strong")
    assert await mcs.usage(db) == {chat.id: ["chat"], small.id: ["floating", "summary"]}
    monkeypatch.setenv("ALERT_INVESTIGATION_ENABLED", "true")
    assert await mcs.usage(db) == {chat.id: ["chat", "investigation"], small.id: ["floating", "summary"]}
    monkeypatch.setenv("ALERT_INVESTIGATION_MODEL", "strong")
    assert await mcs.usage(db) == {chat.id: ["chat"], small.id: ["floating", "summary"], strong.id: ["investigation"]}


def test_the_settings_an_install_gives_are_as_before(monkeypatch):
    for name in ("ALERT_INVESTIGATION_MODEL",):
        monkeypatch.delenv(name, raising=False)
    loaded = inv_settings.load()
    assert loaded.model == "" and loaded.model_from == "features.alertInvestigation.model"


@pytest.mark.asyncio
async def test_a_config_the_chart_names_and_is_not_there_fails_with_the_words_it_had(db):
    with pytest.raises(runner.InvestigationError) as e:
        await runner.build_service(InvestigationSettings(model="gone"), "token", "self")
    assert str(e.value) == 'model config "gone" (features.alertInvestigation.model) not found'


@pytest.mark.asyncio
async def test_choosing_a_model_does_not_change_which_config_the_chat_runs_on(db):
    """Without a default the newest config is the chat's, so a choice must not touch a config's row."""
    older = await add(db, "older")
    await asyncio.sleep(0.01)
    newest = await add(db, "newest")
    assert (await db.get_active_model_config()).id == newest.id
    assert await db.set_model_use(model_uses.INVESTIGATION, older.id)
    assert (await db.get_active_model_config()).id == newest.id
    assert (await db.get_model_config(older.id)).updated_at == older.updated_at


# ---- a choice ----


@pytest.mark.asyncio
async def test_each_kind_of_investigation_follows_its_own_choice(db):
    await add(db, "chat", is_default=True)
    strong, stronger = await add(db, "strong"), await add(db, "stronger")
    webhook, asked = SimpleNamespace(requested_by=""), SimpleNamespace(requested_by="ann@example.com")
    cfg, charted = InvestigationSettings(enabled=True), InvestigationSettings(enabled=True, model="chat")

    async def models(settings):
        return [(await runner.build_service(await model_uses.run_settings(db, settings, row), "t", "self")).model for row in (webhook, asked)]

    await db.set_model_use(model_uses.INVESTIGATION, strong.id)
    assert await models(cfg) == ["strong-model", "strong-model"]  # the ones people ask for go with the webhook's
    assert await models(charted) == ["chat-model", "chat-model"]  # the chart's value decides while it is set
    await db.set_model_use(model_uses.INVESTIGATE_NOW, stronger.id)
    assert await models(cfg) == ["strong-model", "stronger-model"]
    assert await models(charted) == ["chat-model", "stronger-model"]
    await db.set_model_use(model_uses.INVESTIGATION, None)
    assert await models(cfg) == ["chat-model", "stronger-model"]


@pytest.mark.asyncio
async def test_the_worker_runs_each_row_on_its_kinds_choice(db, monkeypatch):
    await add(db, "chat", is_default=True)
    strong = await add(db, "strong")
    await db.set_model_use(model_uses.INVESTIGATE_NOW, strong.id)
    queued = [SimpleNamespace(id="a", requested_by=""), SimpleNamespace(id="b", requested_by="ann@example.com")]
    stop, ran = asyncio.Event(), []

    async def claim_next(_db):
        if queued:
            return queued.pop(0)
        stop.set()
        return None

    async def nothing(*_a, **_k):
        return 0

    async def no_refusal(*_a, **_k):
        return ""

    async def run_one(cfg, _db, row):
        ran.append((row.id, cfg.model, cfg.model_from))

    monkeypatch.setattr(runner.webhook, "wake", asyncio.Event())  # of this test's loop: waiting on it ties it to one
    monkeypatch.setattr(runner.store, "claim_next", claim_next)
    monkeypatch.setattr(runner, "fail_stale", nothing)
    monkeypatch.setattr(runner, "claim_refusal", no_refusal)
    monkeypatch.setattr(runner, "run_one", run_one)
    monkeypatch.setattr(runner, "POLL_SECONDS", 0.01)
    await asyncio.wait_for(runner.worker(stop), timeout=5)
    assert ran == [("a", "", "features.alertInvestigation.model"), ("b", "strong", "Admin → AI Models")]


@pytest.mark.asyncio
async def test_the_optimization_follows_its_choice_and_leaves_the_chat_alone(db):
    await add(db, "chat", is_default=True)
    strong = await add(db, "strong")
    await db.set_model_use(model_uses.OPTIMIZATION, strong.id)
    api._invalidate_caches()
    optimization = await api._build_ai_service("Bearer t", cluster_name="self", use="optimization")
    chat = await api._build_ai_service("Bearer t", cluster_name="self")
    floating = await api._build_ai_service("Bearer t", cluster_name="self", tier="economy")
    assert (optimization.model, chat.model, floating.model) == ("strong-model", "chat-model", "chat-model")
    again = await api._build_ai_service("Bearer t", cluster_name="self", use="optimization")
    assert again.client is optimization.client  # one client, kept
    await db.set_model_use(model_uses.OPTIMIZATION, None)
    api._invalidate_caches()
    assert (await api._build_ai_service("Bearer t", cluster_name="self", use="optimization")).client is (await api._build_ai_service("Bearer t", cluster_name="self")).client


@pytest.mark.asyncio
async def test_a_chosen_optimization_model_does_not_need_the_chats_to_run(db, monkeypatch):
    await add(db, "chat", is_default=True, api_key_env="KUBEAST_AI_KEY_GONE")
    strong = await add(db, "strong")
    await db.set_model_use(model_uses.OPTIMIZATION, strong.id)
    assert (await api._build_ai_service("Bearer t", cluster_name="self", use="optimization")).model == "strong-model"


@pytest.mark.asyncio
async def test_a_choice_is_read_again_within_the_cache_time_and_at_once_after_a_change(db, monkeypatch):
    strong = await add(db, "strong")
    reads = []
    real = db.get_model_uses

    async def counted():
        reads.append(1)
        return await real()

    monkeypatch.setattr(db, "get_model_uses", counted)
    assert await mcs.resolve_use_model_config("optimization") is None
    assert await mcs.resolve_use_model_config("optimization") is None and len(reads) == 1  # "none" is cached too
    await db.set_model_use(model_uses.OPTIMIZATION, strong.id)
    mcs.invalidate_model_config_cache()
    assert (await mcs.resolve_use_model_config("optimization")).model == "strong-model"


@pytest.mark.asyncio
async def test_a_disabled_choice_goes_back_to_what_ran_before_and_a_deleted_one_is_gone(db):
    await add(db, "chat", is_default=True)
    strong = await add(db, "strong")
    row, cfg = SimpleNamespace(requested_by=""), InvestigationSettings(enabled=True)
    for use in model_uses.USES:
        await db.set_model_use(use, strong.id)
    await db.update_model_config(strong.id, {"enabled": False})
    assert await model_uses.run_settings(db, cfg, row) is cfg
    mcs.invalidate_model_config_cache()
    assert await mcs.resolve_use_model_config("optimization") is None
    await db.update_model_config(strong.id, {"enabled": True})
    assert (await model_uses.run_settings(db, cfg, row)).model == "strong"
    assert await db.delete_model_config(strong.id)
    assert await db.get_model_uses() == {}
    # the id may be given to the next config: it does not inherit the choice
    await add(db, "next")
    assert await model_uses.run_settings(db, cfg, row) is cfg


@pytest.mark.asyncio
async def test_a_chosen_model_that_cannot_run_is_not_replaced_by_another(db):
    """The choice also says where the use's data goes: a missing key stops the use with the reason."""
    await add(db, "chat", is_default=True)
    strong = await add(db, "strong", provider="anthropic", api_key_env="KUBEAST_AI_KEY_STRONG")
    for use in model_uses.USES:
        await db.set_model_use(use, strong.id)
    reason = 'API key is missing for model config "strong" (provider=anthropic)'
    with pytest.raises(mcs.ModelConfigUnusable) as e:
        await runner.build_service(await model_uses.run_settings(db, InvestigationSettings(), SimpleNamespace(requested_by="")), "t", "self")
    assert str(e.value) == reason
    with pytest.raises(api.HTTPException) as refused:
        await api._build_ai_service("Bearer t", cluster_name="self", use="optimization")
    assert refused.value.status_code == 503 and refused.value.detail.startswith(reason)
    assert (await api._build_ai_service("Bearer t", cluster_name="self")).model == "chat-model"  # the chat goes on


# ---- a provider that refuses one kind's model ----

REFUSED = "provider refused (credit): RateLimitError"
CFG = InvestigationSettings(enabled=True, webhook_token="hook-token", internal_token="internal", max_per_hour=0)
FINGERPRINTS = (f"fp-{n}" for n in itertools.count())


async def failed(db, *, manual, error=REFUSED, ago=1):
    """A run of one kind that failed `ago` minutes ago."""
    at = NOW - timedelta(minutes=ago)
    inv = await store.insert(db, cluster="self", fingerprint=next(FINGERPRINTS), status="running", received_at=at, requested_by="ops@x" if manual else "")
    await store.finish(db, inv, status="failed", error=error, finished_at=at)


async def held(db, cfg=CFG) -> tuple[bool, bool]:
    """Whether the webhook's investigations and the ones people ask for wait, as the three places that ask say."""
    out = []
    for manual, requested_by in ((False, ""), (True, "ops@x")):
        taken = (await runner.claim_refusal(cfg, db, alert_row(requested_by=requested_by), NOW)).startswith("paused:")
        if manual:
            payload = SimpleNamespace(has_permission_for_cluster=lambda *a: True)
            shown = await api_alert_inbox.investigate_now_of(db, cfg, payload, alert_row(), None, NOW)
            assert (shown["reason"] == "provider_paused", shown["allowed"]) == (taken, not taken)
        else:
            counts = await webhook.gate_and_queue(db, cfg, "self", am_message(alert(fp=next(FINGERPRINTS))), NOW)
            assert (counts["skipped"], counts["accepted"]) == ((1, 0) if taken else (0, 1))
        out.append(taken)
    return tuple(out)


@pytest.mark.parametrize("chart", ["", "chat", "strong"])
@pytest.mark.parametrize("manual", [False, True])
@pytest.mark.parametrize("chosen", [{}, {"optimization": "strong"}, {"investigation": "strong"}])
@pytest.mark.asyncio
async def test_without_a_choice_of_its_own_investigate_now_waits_with_the_webhooks(db, chosen, manual, chart):
    configs = {name: await add(db, name, is_default=name == "chat") for name in ("chat", "strong")}
    for use, name in chosen.items():
        await db.set_model_use(use, configs[name].id)
    cfg = dataclasses.replace(CFG, model=chart)
    assert await held(db, cfg) == (False, False)
    await failed(db, manual=manual)
    assert await held(db, cfg) == (True, True)


@pytest.mark.parametrize("manual", [False, True])
@pytest.mark.parametrize("chart, investigation, asked, apart", [
    ("", None, "strong", True), ("", None, "chat", False),            # the webhook's run on the active config
    ("", "small", "strong", True), ("", "strong", "strong", False),   # on the one chosen for them
    ("small", None, "strong", True), ("small", None, "small", False), # on the chart's
    ("small", "strong", "strong", True),                              # the chart decides over a choice for them
    ("gone", None, "strong", True),                                   # the chart's is not there: theirs fails, it runs
])
@pytest.mark.asyncio
async def test_a_refusal_of_one_kinds_own_model_holds_that_kind_alone(db, chart, investigation, asked, apart, manual):
    configs = {name: await add(db, name, is_default=name == "chat") for name in ("chat", "strong", "small")}
    await db.set_model_use("investigate_now", configs[asked].id)
    if investigation:
        await db.set_model_use("investigation", configs[investigation].id)
    cfg = dataclasses.replace(CFG, model=chart)
    await failed(db, manual=manual)
    assert await held(db, cfg) == ((not manual, manual) if apart else (True, True))


@pytest.mark.asyncio
async def test_each_kind_is_held_by_its_own_last_failure(db):
    await add(db, "chat", is_default=True)
    strong = await add(db, "strong")
    await db.set_model_use("investigate_now", strong.id)
    await failed(db, manual=False, ago=9)
    assert await held(db) == (True, False)
    await failed(db, manual=True, ago=8, error="timed out after 300s")  # says nothing of the webhook's model
    assert await held(db) == (True, False)
    await failed(db, manual=True, ago=7)
    assert await held(db) == (True, True)
    await failed(db, manual=False, ago=6, error="timed out after 300s")  # it answered again
    assert await held(db) == (False, True)
    # the choice taken away: both kinds run on one model again, and the last failure is the webhook's
    await db.set_model_use("investigate_now", None)
    assert await held(db) == (False, False)


@pytest.mark.asyncio
async def test_a_choice_that_is_disabled_holds_both_kinds(db):
    await add(db, "chat", is_default=True)
    strong = await add(db, "strong")
    await db.set_model_use("investigate_now", strong.id)
    await failed(db, manual=True)
    assert await held(db) == (False, True)
    await db.update_model_config(strong.id, {"enabled": False})
    assert await held(db) == (True, True)


@pytest.mark.asyncio
async def test_the_choices_are_read_only_when_the_other_kinds_run_failed_last(db, monkeypatch):
    async def asked(*a, **kw):
        raise AssertionError("the choices were read")

    await add(db, "chat", is_default=True)
    monkeypatch.setattr(model_uses, "kinds_apart", asked)
    assert await held(db) == (False, False)                       # nothing failed
    assert await store.pause_reason(db, 30, NOW) == ""            # not asked for a kind: as before
    await failed(db, manual=False)
    assert await store.pause_reason(db, 30, NOW, manual=False) != "" and await store.pause_reason(db, 30, NOW) != ""
    assert await store.pause_reason(db, 0, NOW, manual=True) == ""  # 0 = never pause


@pytest.mark.asyncio
async def test_used_for_names_a_chosen_use(db, monkeypatch):
    chat = await add(db, "chat", is_default=True)
    strong, stronger = await add(db, "strong"), await add(db, "stronger")
    await db.set_model_use(model_uses.OPTIMIZATION, strong.id)
    await db.set_model_use(model_uses.INVESTIGATION, strong.id)
    await db.set_model_use(model_uses.INVESTIGATE_NOW, stronger.id)
    chat_uses = ["chat", "floating", "summary"]
    assert await mcs.usage(db) == {chat.id: chat_uses, strong.id: ["optimization"]}  # investigations are off
    monkeypatch.setenv("ALERT_INVESTIGATION_ENABLED", "true")
    assert await mcs.usage(db) == {chat.id: chat_uses, strong.id: ["investigation", "optimization"], stronger.id: ["investigate_now"]}
    monkeypatch.setenv("ALERT_INVESTIGATION_MANUAL", "false")
    monkeypatch.setenv("ALERT_INVESTIGATION_MODEL", "chat")
    assert await mcs.usage(db) == {chat.id: [*chat_uses, "investigation"], strong.id: ["optimization"]}


@pytest.mark.asyncio
async def test_two_administrators_choosing_at_once_leave_one_choice(db):
    strong, stronger = await add(db, "strong"), await add(db, "stronger")
    await asyncio.gather(*(db.set_model_use("optimization", c.id) for c in (strong, stronger, strong, stronger)))
    assert list(await db.get_model_uses()) == ["optimization"]
    assert await db.set_model_use("optimization", 999) is False  # a config that is not there
    assert (await db.get_model_uses())["optimization"].name in ("strong", "stronger")


# ---- what the screen is told ----


def by_use(described):
    return {d["use"]: d for d in described}


@pytest.mark.asyncio
async def test_describe_says_what_answers_each_use_and_why(db, monkeypatch):
    chat = await add(db, "chat", is_default=True)
    strong = await add(db, "strong")
    uses = by_use(await model_uses.describe(db))
    assert list(uses) == list(model_uses.USES)
    assert [(u["on"], u["choice"], u["answers"]["name"], u["by"], u["problem"]) for u in uses.values()] == [
        (False, None, "chat", "chat", ""), (False, None, "chat", "investigation", ""), (True, None, "chat", "chat", "")]
    assert [u["daily_token_budget"] for u in uses.values()] == [200_000, 0, None]

    monkeypatch.setenv("ALERT_INVESTIGATION_ENABLED", "true")
    await db.set_model_use(model_uses.INVESTIGATION, strong.id)
    uses = by_use(await model_uses.describe(db))
    assert uses["investigation"]["choice"] == {"id": strong.id, "name": "strong", "enabled": True}
    assert (uses["investigation"]["answers"], uses["investigation"]["by"]) == ({"id": strong.id, "name": "strong"}, "choice")
    assert (uses["investigate_now"]["answers"]["name"], uses["investigate_now"]["by"], uses["investigate_now"]["on"]) == ("strong", "investigation", True)

    monkeypatch.setenv("ALERT_INVESTIGATION_MODEL", "chat")
    uses = by_use(await model_uses.describe(db))
    assert (uses["investigation"]["answers"]["id"], uses["investigation"]["by"], uses["investigation"]["chart_model"]) == (chat.id, "chart", "chat")
    assert uses["investigation"]["choice"]["name"] == "strong"  # kept, and not used while the chart names one
    monkeypatch.setenv("ALERT_INVESTIGATION_MODEL", "gone")
    uses = by_use(await model_uses.describe(db))
    for use in ("investigation", "investigate_now"):
        assert uses[use]["answers"] is None and uses[use]["problem"] == 'model config "gone" (features.alertInvestigation.model) not found'

    monkeypatch.delenv("ALERT_INVESTIGATION_MODEL")
    await db.update_model_config(strong.id, {"enabled": False})
    uses = by_use(await model_uses.describe(db))
    assert uses["investigation"]["choice"]["enabled"] is False and (uses["investigation"]["answers"]["name"], uses["investigation"]["by"]) == ("chat", "chat")


@pytest.mark.asyncio
async def test_describe_names_the_reason_a_use_would_not_run(db, monkeypatch):
    uses = by_use(await model_uses.describe(db))  # no config, no key in the chart's values
    assert uses["optimization"]["answers"] is None and uses["optimization"]["problem"] == mcs.NO_MODEL_CONFIGURED
    strong = await add(db, "strong", provider="anthropic", api_key_env="KUBEAST_AI_KEY_STRONG")
    await db.set_model_use(model_uses.OPTIMIZATION, strong.id)
    assert by_use(await model_uses.describe(db))["optimization"]["problem"] == 'API key is missing for model config "strong" (provider=anthropic)'
    monkeypatch.setenv("KUBEAST_AI_KEY_STRONG", "k")
    assert by_use(await model_uses.describe(db))["optimization"]["problem"] == ""


# ---- the routes ----

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def token(permissions, **claims):
    now = int(time.time())
    return jwt.encode({"sub": "u1", "email": "ann@example.com", "role": "Member", "permissions": permissions, "tv": 0,
                       "iss": security.JWT_ISSUER, "aud": security.JWT_AUDIENCE, "iat": now, "exp": now + 300, **claims},
                      _KEY, algorithm="RS256")


ADMIN = {"*": ["admin.ai_models.*"]}


@pytest.fixture
def rows(monkeypatch):
    out = []

    async def write(**kw):
        out.append(kw)
        return True

    async def ready():
        return None

    monkeypatch.setattr(audit_writer, "write_audit", write)
    monkeypatch.setattr(audit_writer, "require_audit_ready", ready)
    return out


@pytest.fixture
def call(db, monkeypatch):
    """One request as a person holding these permissions."""
    key = SimpleNamespace(key=_KEY.public_key())
    monkeypatch.setattr(security, "_jwk_client", SimpleNamespace(get_signing_key_from_jwt=lambda _t: key))
    monkeypatch.setattr(security, "AUTH_TOKEN_VERSION_URL", "")

    async def get():
        return db

    monkeypatch.setattr("app.api_model_uses.get_db_service", get)

    async def send(method, path, permissions=ADMIN, body=None, **claims):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://kubeast") as client:
            return await client.request(method, path, headers={"Authorization": f"Bearer {token(permissions, **claims)}"}, json=body)

    return send


@pytest.mark.parametrize("permissions, claims", [
    ({}, {}), ({"c": ["*"]}, {}), ({"*": ["admin.audit.read"]}, {}), ({"c": ["resource.*.read"]}, {"akid": "k"}),
], ids=["none", "Admin on one cluster", "another global permission", "an API key"])
@pytest.mark.parametrize("method, path, body", [("GET", ROUTE, None), ("PUT", f"{ROUTE}/optimization", {"config_id": None})])
async def test_only_who_manages_the_models_reads_or_chooses(call, db, rows, method, path, body, permissions, claims):
    assert (await call(method, path, permissions, body, **claims)).status_code == 403
    assert rows == [] and await db.get_model_uses() == {}


def test_the_routes_need_a_sign_in():
    client = TestClient(app)
    assert client.get(ROUTE).status_code == 401
    assert client.put(f"{ROUTE}/optimization", json={"config_id": None}).status_code == 401


async def test_choosing_and_taking_a_choice_away_is_recorded_with_what_it_was(call, db, rows):
    await add(db, "chat", is_default=True)
    strong = await add(db, "strong", base_url="https://104.18.6.192/v1", extra_headers={"X-Team": "secret-value"})  # no name to resolve
    res = await call("PUT", f"{ROUTE}/optimization", body={"config_id": strong.id})
    assert res.status_code == 200, res.text
    assert by_use(res.json()["uses"])["optimization"]["answers"]["name"] == "strong"
    assert (await call("GET", ROUTE)).json() == res.json()
    row = rows[-1]
    assert (row["action"], row["target_type"], row["target_id"], row["result"]) == ("ai.model_config.use", "model_config", "strong", "success")
    assert (row["actor_email"], row["path"]) == ("ann@example.com", f"{ROUTE}/optimization")
    after = row["after"]
    assert (after["use"], after["from"], after["to"]) == ("optimization", None, "strong") and "before" not in after
    assert after["after"]["model"] == "strong-model" and after["after"]["base_url"] == "https://104.18.6.192/v1"
    assert "secret-value" not in str(row) and "sk-test" not in str(row)

    assert (await call("PUT", f"{ROUTE}/optimization", body={"config_id": None})).status_code == 200
    row = rows[-1]
    assert (row["target_id"], row["after"]["from"], row["after"]["to"]) == ("strong", "strong", None) and row["after"]["before"]["model"] == "strong-model"
    assert await db.get_model_uses() == {}


async def test_a_change_takes_effect_at_once_in_the_process_that_made_it(call, db, rows):
    await add(db, "chat", is_default=True)
    strong = await add(db, "strong")
    assert (await api._build_ai_service("Bearer t", cluster_name="self", use="optimization")).model == "chat-model"
    assert (await call("PUT", f"{ROUTE}/optimization", body={"config_id": strong.id})).status_code == 200
    assert (await api._build_ai_service("Bearer t", cluster_name="self", use="optimization")).model == "strong-model"


async def test_a_refused_choice_is_a_failure_row_and_changes_nothing(call, db, rows, monkeypatch):
    chat = await add(db, "chat", is_default=True)
    off = await add(db, "off", enabled=False)
    no_key = await add(db, "nokey", provider="anthropic", api_key_env="KUBEAST_AI_KEY_STRONG")
    monkeypatch.setenv("ALERT_INVESTIGATION_MODEL", "chat")
    cases = [
        ("chat", chat.id, 404, "use must be one of investigation, investigate_now, optimization"),
        ("optimization", 999, 404, "Model config not found"),
        ("optimization", off.id, 400, 'model config "off" is disabled'),
        ("optimization", no_key.id, 400, 'API key is missing for model config "nokey" (provider=anthropic)'),
        ("investigation", chat.id, 409, 'features.alertInvestigation.model names "chat" in the chart, which decides for alert investigations'),
    ]
    for use, config_id, status, detail in cases:
        res = await call("PUT", f"{ROUTE}/{use}", body={"config_id": config_id})
        assert (res.status_code, res.json()["detail"]) == (status, detail)
        assert (rows[-1]["action"], rows[-1]["result"], rows[-1]["error"]) == ("ai.model_config.use", "failure", detail)
        assert (rows[-1]["after"]["use"], rows[-1]["after"]["config_id"], rows[-1]["after"]["to"]) == (use, config_id, None)
    assert len(rows) == len(cases) and await db.get_model_uses() == {}
    # a choice made before the chart named a model can still be taken away
    await db.set_model_use("investigation", chat.id)
    assert (await call("PUT", f"{ROUTE}/investigation", body={"config_id": None})).status_code == 200
    # "Investigate now" has its own choice, whatever the chart names
    assert (await call("PUT", f"{ROUTE}/investigate_now", body={"config_id": chat.id})).status_code == 200


@pytest.mark.parametrize("body", [{}, {"config_id": True}, {"config_id": "1"}, {"config_id": 1.5}, {"config_id": 0}, {"config_id": 2**31}])
async def test_a_body_that_names_no_config_changes_nothing(call, db, rows, body):
    strong = await add(db, "strong")
    await db.set_model_use("optimization", strong.id)
    assert (await call("PUT", f"{ROUTE}/optimization", body=body)).status_code == 422
    assert (await db.get_model_uses())["optimization"].id == strong.id


async def test_nothing_is_changed_that_could_not_be_recorded(call, db, monkeypatch):
    strong = await add(db, "strong")

    async def down():
        raise audit_writer.AuditUnavailable("db")

    monkeypatch.setattr(audit_writer, "require_audit_ready", down)
    res = await call("PUT", f"{ROUTE}/optimization", body={"config_id": strong.id})
    assert (res.status_code, res.json()["detail"]) == (503, "audit unavailable")
    assert await db.get_model_uses() == {}
