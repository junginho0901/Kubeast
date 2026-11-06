"""What a screen reads, the AI reads too. k8s-service's and auth-service's tests hold every GET route to a row of
ai_route_coverage.json and tool-server's holds the tool to its row. Here: the model is offered that tool, and the row's call
is one the model can make."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.ai import tools as catalog
from app.services.tool_whitelists import ACTION_TOOL_NAMES, WRITE_TOOL_NAMES

TABLE = json.loads((Path(__file__).parent / "fixtures" / "ai_route_coverage.json").read_text(encoding="utf-8"))
ROWS = [(service, route, row) for service, rows in TABLE.items() for route, row in rows.items()]
COVERED = [(service, route, row) for service, route, row in ROWS if "tool" in row]


def _definitions() -> dict:
    tools = catalog.get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda tools: tools))
    return {tool["function"]["name"]: tool["function"].get("parameters", {}) for tool in tools}


@pytest.mark.parametrize("service,route,row", COVERED, ids=[f"{s} {r}" for s, r, _ in COVERED])
def test_the_model_can_make_the_call_a_route_is_covered_by(service, route, row):
    parameters = _definitions().get(row["tool"])
    assert parameters is not None, f"{row['tool']} is not offered to the model"
    declared = set(parameters.get("properties", {}))
    assert set(row["args"]) <= declared, f"{row['tool']} declares no {set(row['args']) - declared}"
    assert set(parameters.get("required", [])) <= set(row["args"]), f"{row['tool']} needs {parameters.get('required')}"


@pytest.mark.parametrize("service,route,row", COVERED, ids=[f"{s} {r}" for s, r, _ in COVERED])
def test_a_read_is_covered_by_a_read(service, route, row):
    assert row["tool"] not in WRITE_TOOL_NAMES
    assert row["tool"] not in ACTION_TOOL_NAMES


@pytest.mark.parametrize("service,route,row", ROWS, ids=[f"{s} {r}" for s, r, _ in ROWS])
def test_a_route_has_a_tool_or_a_reason(service, route, row):
    assert ("tool" in row) != ("excluded" in row)
    if "excluded" in row:
        assert len(row["excluded"]) >= 40
