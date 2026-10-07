"""The optimization observations are k8s-service's table rendered as markdown
plus a draft made from its flags — numbers pass through unchanged."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.services.ai.optimization import (
    build_optimization_observations,
    draft_from_flags,
    render_optimization_table,
)

SAMPLE = {
    "namespace": "web",
    "window_hours": 24,
    "source": "prometheus",
    "totals": {"pods": 3, "cpu_request_m": 1100, "cpu_recommend_m": 210, "mem_request_bytes": 1152 << 20, "mem_recommend_bytes": 560 << 20},
    "rows": [
        {
            "kind": "Deployment", "name": "api", "container": "app", "pods": 2,
            "cpu_request_m": 500, "cpu_limit_m": 1000, "cpu_usage_m": 55, "cpu_recommend_m": 55,
            "mem_request_bytes": 512 << 20, "mem_limit_bytes": 1 << 30, "mem_usage_bytes": 200 << 20, "mem_recommend_bytes": 230 << 20,
            "flags": ["cpu_over", "mem_over"],
        },
        {
            "kind": "StatefulSet", "name": "db", "container": "postgres", "pods": 1,
            "cpu_request_m": 100, "cpu_limit_m": 0, "cpu_usage_m": 250, "cpu_recommend_m": 250,
            "mem_request_bytes": 128 << 20, "mem_limit_bytes": 0, "mem_usage_bytes": 300 << 20, "mem_recommend_bytes": 345 << 20,
            "flags": ["no_mem_limit", "cpu_under", "mem_under"],
        },
        {
            "kind": "Pod", "name": "bare", "container": "sh", "pods": 1,
            "cpu_request_m": 0, "cpu_limit_m": 0, "mem_request_bytes": 0, "mem_limit_bytes": 0, "flags": [],
        },
    ],
}


def test_render_table_keeps_the_numbers_and_marks_unset_values():
    md = render_optimization_table(SAMPLE)
    assert "## Observed data (`web`)" in md
    assert "Prometheus over the last 24h" in md
    assert "CPU request 1100m → recommended 210m" in md
    assert "| `Deployment/api` | app | 2 | 500m/1000m | 55m | 55m | 512Mi/1024Mi | 200Mi | 230Mi | cpu_over, mem_over |" in md
    assert "| `StatefulSet/db` | postgres | 1 | 100m/- | 250m | 250m | 128Mi/- | 300Mi | 345Mi | no_mem_limit, cpu_under, mem_under |" in md
    assert "| `Pod/bare` | sh | 1 | -/- | - | - | -/- | - | - | - |" in md


def test_render_table_without_usage_says_so():
    md = render_optimization_table({**SAMPLE, "source": "none", "totals": {"pods": 3}})
    assert "no usage data" in md
    assert "recommended" not in md.split("\n")[1:4][-1]


def test_draft_lists_only_flagged_rows_with_their_numbers():
    draft = draft_from_flags(SAMPLE)
    lines = draft.split("\n")
    assert len(lines) == 2
    assert lines[0].startswith("- `Deployment/api (app)`: CPU request is at least double")
    assert "request 500m, usage 55m, recommended 55m" in lines[0]
    assert "request 512Mi, usage 200Mi, recommended 230Mi" in lines[0]
    assert "no memory limit" in lines[1] and "request 100m, usage 250m, recommended 250m" in lines[1]


@pytest.mark.asyncio
async def test_build_observations_calls_k8s_service_for_the_namespace():
    service = SimpleNamespace(k8s_service=SimpleNamespace(get_optimization=AsyncMock(return_value=SAMPLE)))
    out = await build_optimization_observations(service, "web")
    service.k8s_service.get_optimization.assert_awaited_once_with("web")
    assert out["observations_md"].startswith("## Observed data (`web`)")
    assert "`Deployment/api (app)`" in out["action_plan_md"]
    assert '"source": "prometheus"' in out["observations_text"]
