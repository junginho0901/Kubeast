"""The read-only tools are written in three places that must agree: READONLY_TOOL_NAMES here (the read-only widget, what
the alert investigator is offered and what it is refused), auth-service's ReadAIToolPermissions (the Read role's ai.tool.*
keys, and through InvestigatorPermissions the investigator's token, whose content repository_schema_test.go holds) and
tool-server's copy of the Read role behind tool_screen_permission_cases.json. A tool added to one list and not to another
is offered to the investigator by one service and refused by the other."""
import json
import re
from pathlib import Path

from app.services.tool_whitelists import READONLY_TOOL_NAMES

SERVICES = Path(__file__).resolve().parents[2]
SCHEMA = SERVICES / "auth-service-go" / "internal" / "repository" / "repository_schema.go"
SCREEN = Path(__file__).parent / "fixtures" / "tool_screen_permission_cases.json"


def _strings(source: str, pattern: str) -> list[str]:
    found = re.search(pattern, source, re.S)
    assert found, f"{SCHEMA.name} no longer has {pattern}"
    return re.findall(r'"([^"]+)"', found.group(1))


def _apart(tools: set[str]) -> tuple[list[str], list[str]]:
    """(only in the other list, only in READONLY_TOOL_NAMES)"""
    return sorted(tools - READONLY_TOOL_NAMES), sorted(READONLY_TOOL_NAMES - tools)


def test_the_read_roles_tools_are_the_read_only_tools():
    source = SCHEMA.read_text(encoding="utf-8")
    keys = _strings(source, r"var ReadAIToolPermissions = \[\]string\{(.*?)\n\}")
    assert sorted({k for k in keys if keys.count(k) > 1}) == []
    assert [k for k in keys if not re.fullmatch(r"ai\.tool\.[a-z0-9_]+", k)] == []
    assert _apart({k.removeprefix("ai.tool.") for k in keys}) == ([], [])
    # The Read role adds no tool to that list, and the investigator's token starts from it.
    seeded = _strings(source, r'\{"Read", "[^"]*", append\(\[\]string\{(.*?)\}, ReadAIToolPermissions\.\.\.\)\}')
    assert [k for k in seeded if k.startswith("ai.tool")] == []
    assert re.search(r"var InvestigatorPermissions = append\(append\(\[\]string\{\}, ReadAIToolPermissions\.\.\.\), ", source)


def test_tool_servers_read_role_has_the_read_only_tools():
    read_role = json.loads(SCREEN.read_text(encoding="utf-8"))["read_role"]
    assert _apart({k.removeprefix("ai.tool.") for k in read_role if k.startswith("ai.tool.")}) == ([], [])
