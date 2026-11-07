"""What the model is told about Helm names only tools it has: a tool that does not exist sends it asking for a call that
cannot run, and sends the person looking for an approval card that never comes."""
import json
import re

from app.services.ai.prompts import SYSTEM_MESSAGE
from app.services.ai.tools import K8S_READONLY_TOOLS, K8S_WRITE_TOOLS
from app.services.tool_whitelists import READONLY_TOOL_NAMES, WRITE_TOOL_NAMES

_HELM_TOOL = re.compile(r"\bhelm_[a-z_]+\b")
_DEFINED = READONLY_TOOL_NAMES | WRITE_TOOL_NAMES


def test_the_system_message_names_only_defined_helm_tools():
    assert set(_HELM_TOOL.findall(SYSTEM_MESSAGE)) <= _DEFINED


def test_the_tool_descriptions_name_only_defined_helm_tools():
    assert set(_HELM_TOOL.findall(json.dumps([*K8S_READONLY_TOOLS, *K8S_WRITE_TOOLS]))) <= _DEFINED


def test_helm_read_says_where_a_release_is_changed():
    described = next(t for t in K8S_READONLY_TOOLS if t["function"]["name"] == "helm_read")["function"]["description"]
    assert "Helm screen" in described
