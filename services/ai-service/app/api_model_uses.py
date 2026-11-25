"""/api/v1/ai/model-configs/uses — which model config answers which use (app/services/model_uses.py).

Who: whoever manages the AI models (admin.ai_models.*), reading and changing. A change is an ai.model_config.use row,
refusals too, and is made only when that row can be stored. Other replicas follow within the 30 s their configs are cached."""

from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, StrictInt

from app import api
from app.database import get_db_service
from app.security import TokenPayload, require_admin
from app.services import model_config_audit, model_uses
from app.services.investigation import settings as inv_settings

router = APIRouter()


class UseIn(BaseModel):
    # required; null: no choice, the use runs as it did before one
    config_id: Optional[Annotated[StrictInt, Field(ge=1, le=2_147_483_647)]]


@router.get("/uses")
async def list_model_uses(payload: TokenPayload = Depends(require_admin)) -> dict[str, Any]:
    return {"uses": await model_uses.describe(await get_db_service())}


async def _config_to_choose(db, use: str, config_id: int):
    config = await db.get_model_config(config_id)
    if config is None:
        raise HTTPException(status_code=404, detail="Model config not found")
    if not config.enabled:
        raise HTTPException(status_code=400, detail=f'model config "{config.name}" is disabled')
    chart = inv_settings.load().model
    if use == model_uses.INVESTIGATION and chart:
        raise HTTPException(status_code=409, detail=f'features.alertInvestigation.model names "{chart}" in the chart, which decides for alert investigations')
    problem = await model_uses.problem_of(config)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    return config


@router.put("/uses/{use}")
async def set_model_use(use: str, body: UseIn, request: Request, payload: TokenPayload = Depends(require_admin)) -> dict[str, Any]:
    await model_config_audit.ready_or_503("model use change")
    db = await get_db_service()
    before = after = None

    async def record(**outcome) -> None:
        name = (after or before).name if after is not None or before is not None else None
        await model_config_audit.record(
            "ai.model_config.use", payload, request, name, before=before, after=after,
            extra={"use": use[:100], "config_id": body.config_id, "from": before.name if before is not None else None,
                   "to": after.name if after is not None else None}, **outcome)

    try:
        if use not in model_uses.USES:
            raise HTTPException(status_code=404, detail=f"use must be one of {', '.join(model_uses.USES)}")
        before = (await db.get_model_uses()).get(use)
        if body.config_id is not None:
            after = await _config_to_choose(db, use, body.config_id)
        if not await db.set_model_use(use, body.config_id):
            raise HTTPException(status_code=404, detail="Model config not found")
    except HTTPException as e:
        await record(result="failure", error=str(e.detail))
        raise
    await record()
    api._invalidate_caches()
    return {"uses": await model_uses.describe(db)}
