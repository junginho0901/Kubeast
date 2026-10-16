"""Model config tier: an enabled economy-tier config serves the floating
assistant and the chat's history summaries; without one, both use the active
config."""
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.models.model_config import ModelConfigCreate, ModelConfigUpdate
from app.services.ai_service import AIService


def _resolved(model):
    return SimpleNamespace(provider="openai", model=model, base_url=None, api_key="k", extra_headers=None,
                           tls_verify=True, ca_cert=None, options=None)


@pytest.fixture
def builder(monkeypatch):
    from app import api
    import app.services.ai_service as ai_service_module
    import app.services.model_config_service as mcs

    built = []

    class FakeAIService(AIService):
        def __init__(self, **kwargs):  # no LLM client construction
            self.client = SimpleNamespace(model=kwargs.get("model"))
            self.model = kwargs.get("model")
            self.provider = kwargs.get("provider")
            self._provider_name = self.provider
            self.tool_contexts = {}
            self._token_payload = None
            self.update_authorization(None, cluster_name=None)
            built.append(self.model)

    state = {"economy": None}

    async def fake_resolve():
        return _resolved("big-model")

    async def fake_economy():
        return state["economy"]

    monkeypatch.setattr(mcs, "resolve_model_config", fake_resolve)
    monkeypatch.setattr(mcs, "resolve_economy_model_config", fake_economy)
    monkeypatch.setattr(ai_service_module, "AIService", FakeAIService)
    api._cached_ai_service, api._cached_ai_config_hash = None, ""
    api._cached_economy_service, api._cached_economy_hash = None, ""
    return SimpleNamespace(api=api, state=state, built=built)


@pytest.mark.asyncio
async def test_without_an_economy_config_everything_uses_the_active_one(builder):
    chat = await builder.api._build_ai_service("Bearer t", cluster_name="self")
    floating = await builder.api._build_ai_service("Bearer t", cluster_name="self", tier="economy")
    assert (chat.model, chat.tier, chat.summary_model) == ("big-model", "default", "big-model")
    assert (floating.model, floating.tier, floating.summary_model) == ("big-model", "default", "big-model")
    assert chat.summary_client is chat.client


@pytest.mark.asyncio
async def test_the_economy_config_serves_the_floating_assistant_and_every_summary(builder):
    builder.state["economy"] = _resolved("small-model")
    chat = await builder.api._build_ai_service("Bearer t", cluster_name="self")
    floating = await builder.api._build_ai_service("Bearer t", cluster_name="self", tier="economy")
    assert (chat.model, chat.tier, chat.summary_model) == ("big-model", "default", "small-model")
    assert (floating.model, floating.tier, floating.summary_model) == ("small-model", "economy", "small-model")
    assert chat.summary_client is floating.client  # one shared economy client
    # Both LLM clients are built once and reused.
    await builder.api._build_ai_service("Bearer t", cluster_name="self", tier="economy")
    assert sorted(builder.built) == ["big-model", "small-model"]


@pytest.mark.asyncio
async def test_removing_the_economy_config_drops_its_client(builder):
    builder.state["economy"] = _resolved("small-model")
    await builder.api._build_ai_service("Bearer t", cluster_name="self")
    builder.state["economy"] = None
    floating = await builder.api._build_ai_service("Bearer t", cluster_name="self", tier="economy")
    assert (floating.model, floating.tier, floating.summary_model) == ("big-model", "default", "big-model")
    assert builder.api._cached_economy_service is None


@pytest.mark.asyncio
async def test_resolve_economy_uses_the_db_row_caches_and_skips_an_unusable_one(monkeypatch):
    import app.services.model_config_service as mcs

    rows = {"row": None}
    calls = []

    class DB:
        async def get_economy_model_config(self):
            calls.append(1)
            return rows["row"]

    async def get_db():
        return DB()

    monkeypatch.setattr(mcs, "get_db_service", get_db)
    mcs.invalidate_model_config_cache()
    assert await mcs.resolve_economy_model_config() is None
    assert await mcs.resolve_economy_model_config() is None and len(calls) == 1  # "none" is cached too

    rows["row"] = SimpleNamespace(id=7, provider="ollama", model="granite4.1:8b", base_url=None,
                                  api_key_env=None, api_key_secret_key=None, extra_headers={}, tls_verify=True,
                                  ca_cert=None, options=None)
    mcs.invalidate_model_config_cache()
    resolved = await mcs.resolve_economy_model_config()
    assert (resolved.provider, resolved.model) == ("ollama", "granite4.1:8b")

    # A cloud provider without its key is not usable: the active config is used instead.
    rows["row"] = SimpleNamespace(id=8, provider="anthropic", model="claude-haiku-5-5", base_url=None,
                                  api_key_env="ANTHROPIC_API_KEY", api_key_secret_key=None, extra_headers={},
                                  tls_verify=True, ca_cert=None, options=None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(mcs.settings, "OPENAI_API_KEY", "", raising=False)
    mcs.invalidate_model_config_cache()
    assert await mcs.resolve_economy_model_config() is None
    mcs.invalidate_model_config_cache()


def test_the_api_accepts_only_the_two_tiers():
    assert ModelConfigCreate(name="n", model="m").tier == "default"
    assert ModelConfigCreate(name="n", model="m", tier="economy").tier == "economy"
    assert ModelConfigUpdate(tier="economy").tier == "economy" and ModelConfigUpdate().tier is None
    with pytest.raises(ValidationError):
        ModelConfigCreate(name="n", model="m", tier="cheap")
