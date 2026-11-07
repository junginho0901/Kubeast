"""What the model is told names only tools it has: a tool that does not exist sends it asking for a call that cannot run,
and sends the person looking for an approval card that never comes."""
import json
import re
from types import SimpleNamespace

import pytest

from app.prompts.floating_system_prompt import FLOATING_BASE_SYSTEM_PROMPT
from app.services.ai.prompts import SYSTEM_MESSAGE
from app.services.ai.tools import K8S_READONLY_TOOLS, get_tools_definition
from app.services.investigation.prompt import system_prompt

_TOOL_NAME = re.compile(r"\b(?:helm|k8s)_[a-z_]+\b")
_ALL_TOOLS = get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda tools: tools))
# Not tools: the label names OpenTelemetry writes, which the query examples in these texts use.
_LABELS = {"k8s_container_name", "k8s_namespace_name", "k8s_node_name", "k8s_pod_name"}
_DEFINED = {tool["function"]["name"] for tool in _ALL_TOOLS} | _LABELS
_TEXTS = {
    "the system message": SYSTEM_MESSAGE,
    "the floating chat's system prompt": FLOATING_BASE_SYSTEM_PROMPT,
    "an investigation's system prompt": system_prompt(cluster="c1", namespace="shop", language="en"),
    "the tool descriptions": json.dumps(_ALL_TOOLS),
}


@pytest.mark.parametrize("text", _TEXTS.values(), ids=_TEXTS.keys())
def test_what_the_model_reads_names_only_defined_tools(text):
    assert set(_TOOL_NAME.findall(text)) - _DEFINED == set()


@pytest.mark.parametrize("name", ["k8s_no_such_tool", "helm_no_such_tool"])
def test_a_name_no_tool_has_is_seen(name):
    assert set(_TOOL_NAME.findall(f"call `{name}` next")) - _DEFINED == {name}


def test_helm_read_says_where_a_release_is_changed():
    described = next(t for t in K8S_READONLY_TOOLS if t["function"]["name"] == "helm_read")["function"]["description"]
    assert "Helm screen" in described
