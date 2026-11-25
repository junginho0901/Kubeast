"""The model config an administrator chose for a use of the AI (admin.ai_models.*; table model_uses).

The chat runs on the active config and the floating assistant and the history summaries on the economy one; those choices
are the config's own (is_default, tier). Here are the uses that run on another use's config until one is chosen:

- investigation: the alert investigations the webhook starts — the config features.alertInvestigation.model names in the
  chart, else the active one. The chart's value decides while it is set, so a choice here does nothing then.
- investigate_now: the ones a person asks for — the same config as the webhook's. A choice here is its own, whatever the
  chart names.
- optimization: the Optimization screen's explanation — the active config.

A use with no choice runs as it did before there was one, and so does a use whose chosen config is disabled; deleting a
config takes its choices with it. An enabled config that cannot run (no key in ai-service, a refused address) is not
replaced by another one: the use stops with the reason, since the choice also says where its data goes."""

from __future__ import annotations

import asyncio
import dataclasses
from typing import Any, Dict, Optional

from app.database import DatabaseService, ModelConfig
from app.services.investigation import settings as inv_settings
from app.services.investigation import store as inv_store
from app.services.investigation.settings import InvestigationSettings

INVESTIGATION = "investigation"
INVESTIGATE_NOW = "investigate_now"
OPTIMIZATION = "optimization"
USES = (INVESTIGATION, INVESTIGATE_NOW, OPTIMIZATION)

# InvestigationSettings.model_from of a run whose model was chosen here
CHOSEN_IN = "Admin → AI Models"


async def chosen(db) -> Dict[str, ModelConfig]:
    """The enabled config of each use that has a choice."""
    return {use: config for use, config in (await db.get_model_uses()).items() if config.enabled and use in USES}


def for_investigation(choices: Dict[str, ModelConfig], cfg: InvestigationSettings, *, manual: bool) -> Optional[ModelConfig]:
    """The config chosen for this kind of investigation; None: the chart's, else the active one, as without a choice."""
    if manual and INVESTIGATE_NOW in choices:
        return choices[INVESTIGATE_NOW]
    return None if cfg.model else choices.get(INVESTIGATION)


async def run_settings(db, cfg: InvestigationSettings, row) -> InvestigationSettings:
    """The settings one investigation runs with: `cfg` itself, or a copy naming the config chosen for its kind."""
    config = for_investigation(await chosen(db), cfg, manual=bool(getattr(row, "requested_by", "")))
    return cfg if config is None else dataclasses.replace(cfg, model=config.name, model_from=CHOSEN_IN)


async def kinds_apart(session, chart_model: str) -> bool:
    """Whether "Investigate now" runs on another config than the webhook's investigations, so that a refusal of one's
    model says nothing of the other's. Without a choice of its own it runs on theirs."""
    choices = {use: config for use, config in (await DatabaseService.read_model_uses(session)).items() if config.enabled}
    asked = choices.get(INVESTIGATE_NOW)
    if asked is None:
        return False
    if chart_model:
        return asked.name != chart_model
    webhook = choices.get(INVESTIGATION) or (await session.execute(DatabaseService.active_model_config_query())).scalar_one_or_none()
    return webhook is None or asked.id != webhook.id


def _problem(config: Optional[ModelConfig]) -> str:
    from app.services.model_config_service import _build_resolved, named

    try:
        _build_resolved(config, named(config))
    except ValueError as e:
        return str(getattr(e, "detail", e))  # a refused address is named for whoever manages the models
    return ""


async def problem_of(config: Optional[ModelConfig]) -> str:
    """Why the config (None: the chart's ai.* values) cannot run now, or "". Off the event loop: it resolves the config's host."""
    return await asyncio.to_thread(_problem, config)


async def describe(db) -> list[dict[str, Any]]:
    """Each use as Admin → AI Models shows it: `choice`, the config chosen (a disabled one too); `answers`, the config it
    runs on now (null: the chart's ai.* values, or none), and `by`, what decided that (choice, chart, investigation: the
    webhook's, chat: the active config); `on`, whether this install runs it; `problem`, why it would not run; and the
    daily token budget of an investigation's kind (0: none), which counts tokens whichever model answers."""
    stored = await db.get_model_uses()
    choices = {use: config for use, config in stored.items() if config.enabled and use in USES}
    active = await db.get_active_model_config()
    inv = inv_settings.load()

    webhook, webhook_by, missing = choices.get(INVESTIGATION), "choice", ""
    if inv.model:
        config_id = await inv_store.model_config_id(db, inv.model)
        webhook, webhook_by = (await db.get_model_config(config_id) if config_id is not None else None), "chart"
        if webhook is None:
            missing = f'model config "{inv.model}" ({inv.model_from}) not found'
    elif webhook is None:
        webhook, webhook_by = active, "chat"

    problems: dict[Any, str] = {}  # each config is looked at once, however many uses run on it

    async def use(name: str, on: bool, answers: Optional[ModelConfig], by: str, *, problem: str = "", budget: Optional[int] = None) -> dict[str, Any]:
        if not problem:
            key = getattr(answers, "id", None)
            if key not in problems:
                problems[key] = await problem_of(answers)
            problem = problems[key]
        choice = stored.get(name)
        return {
            "use": name,
            "on": on,
            "choice": None if choice is None else {"id": choice.id, "name": choice.name, "enabled": bool(choice.enabled)},
            "answers": None if answers is None else {"id": answers.id, "name": answers.name},
            "by": by,
            "problem": problem,
            "chart_model": inv.model if name == INVESTIGATION else "",
            "daily_token_budget": budget,
        }

    asked, optimization = choices.get(INVESTIGATE_NOW), choices.get(OPTIMIZATION)
    return [
        await use(INVESTIGATION, inv.enabled and inv.automatic, webhook, webhook_by, problem=missing, budget=inv.daily_token_budget),
        await use(INVESTIGATE_NOW, inv.enabled and inv.manual, asked or webhook, "choice" if asked else "investigation",
                  problem="" if asked else missing, budget=inv.manual_daily_token_budget),
        await use(OPTIMIZATION, True, optimization or active, "choice" if optimization else "chat"),
    ]
