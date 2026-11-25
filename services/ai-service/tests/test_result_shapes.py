"""traces_get's span table (AI_TRACE_SPAN_TABLE, chart ai.traceSpanTable) and k8s_get_resource_yaml with the spec first
(AI_YAML_SPEC_FIRST, chart ai.yamlSpecFirst), both off by default, made by tool-server: the two tools are offered with the
words of the answers they give, and the line at the end of such a YAML stays when the YAML is cut to the model's length.
Off, the tools and what the model reads of every result are as they were."""
import json
from types import SimpleNamespace

import pytest

from app.services.ai import features, formatters, limits, tool_results, tools

TABLE, YAML = "AI_TRACE_SPAN_TABLE", "AI_YAML_SPEC_FIRST"
CHANGED = {
    "traces_get": (TABLE, tools.TRACE_SPANS, tools.TRACE_TABLE),
    "k8s_get_resource_yaml": (YAML, tools.YAML_AS_PRINTED, tools.YAML_SPEC_FIRST),
}
CATALOGUE = [*tools.CLUSTER_METRICS_TOOLS, *tools.K8S_READONLY_TOOLS]
CUT = "\n... (truncated for LLM) ..."
LINE = '# differs from last-applied: spec.replicas: 1 → 2; data.WEB_WORKERS: "3" → "6"'


def _described(offered):
    return {t["function"]["name"]: t["function"]["description"] for t in offered}


@pytest.fixture(autouse=True)
def both_off(monkeypatch):
    for name in (TABLE, YAML, "AI_TOOL_RESULT_DETAILS", "AI_TOOL_RESULTS_JSON"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("value", [None, "", "false", "0"])
def test_off_the_tools_are_the_ones_they_were(monkeypatch, value):
    for name in (TABLE, YAML):
        if value is not None:
            monkeypatch.setenv(name, value)
    assert tools.offer_result_shapes(CATALOGUE) is CATALOGUE
    off = _described(CATALOGUE)
    assert "service, name, kind, start, duration, status and attributes" in off["traces_get"]
    assert off["k8s_get_resource_yaml"] == "단일 리소스의 YAML을 조회합니다 (kubectl get -o yaml)."


@pytest.mark.parametrize("on", [[TABLE], [YAML], [TABLE, YAML]])
def test_on_only_the_words_of_the_answer_change(monkeypatch, on):
    for name in on:
        monkeypatch.setenv(name, "true")
    before, after = _described(CATALOGUE), _described(tools.offer_result_shapes(CATALOGUE))
    assert {name for name in before if before[name] != after[name]} == {name for name, (env, *_) in CHANGED.items() if env in on}
    for name, (env, words, instead) in CHANGED.items():
        assert before[name].count(words) == 1  # the words are the tool's, once
        assert after[name] == (before[name].replace(words, instead) if env in on else before[name])
    for kept, offered in zip(CATALOGUE, tools.offer_result_shapes(CATALOGUE), strict=True):
        assert kept["function"]["parameters"] == offered["function"]["parameters"]
    assert _described(CATALOGUE) == before  # the catalogue itself is left as it is


@pytest.mark.asyncio
@pytest.mark.parametrize("on", [False, True])
async def test_the_chat_and_an_investigation_are_offered_them_by_the_switch(monkeypatch, on):
    # both take their list from gate_tools
    for name in (TABLE, YAML):
        monkeypatch.setenv(name, "true" if on else "false")

    async def served(k8s_client, cluster):
        return {"traceStore": {"enabled": True, "clusters": ["self"]}}

    monkeypatch.setattr(features, "fetch_features", served)
    offered = _described(await features.gate_tools(CATALOGUE, SimpleNamespace(cluster_name="self", token=None, k8s_service=SimpleNamespace())))
    for name, (_env, words, instead) in CHANGED.items():
        assert (instead if on else words) in offered[name]
    if on:
        assert "attributes — errors first" not in offered["traces_get"]


def test_the_mcp_server_lists_them_by_the_switch(monkeypatch):
    from app import mcp_server

    off = mcp_server._read_tools()
    for name in (TABLE, YAML):
        monkeypatch.setenv(name, "true")
    on = mcp_server._read_tools()
    assert {name for name in off if off[name] != on[name]} == set(CHANGED)
    for name, (_env, _words, instead) in CHANGED.items():
        assert " ".join(instead.split()) in on[name].description


def test_a_table_is_an_answer_that_holds_something():
    # as an investigation's outcome check reads the trace tools' answers
    from app.services.investigation import answers

    table = json.dumps({"trace_id": "4bf92f3577b34da6", "namespace": "shop", "errors": 0, "shown": 1, "columns": "start_ms | ms",
                        "table": ["0.0 | 12.0 | 12.0 |  | web | SERVER | GET /"], "legend": "…"})
    assert not answers.empty("traces_get", table) and answers.unread("traces_get", table, None) is None
    assert answers.empty("traces_get", json.dumps({"trace_id": "4bf92f3577b34da6", "errors": 0, "shown": 0, "spans": []}))


def _yaml(lines: int, last: str = LINE) -> str:
    body = "".join(f"  key-{i:04d}: {'v' * 40}\n" for i in range(lines))
    return f"apiVersion: v1\nkind: ConfigMap\ndata:\n{body}metadata:\n  name: app\n{last}\n"


def test_off_a_long_yaml_is_cut_as_it_was(monkeypatch):
    text = _yaml(400)
    for value in (None, "false"):
        if value is not None:
            monkeypatch.setenv(YAML, value)
        monkeypatch.setenv(TABLE, "true")
        assert formatters._truncate_tool_result_for_llm(text, 6000, tool="k8s_get_resource_yaml") == text[:6000] + CUT
        assert formatters._truncate_tool_result_for_llm(text, 6000) == text[:6000] + CUT


def test_on_the_line_stays_when_the_yaml_above_it_is_cut(monkeypatch):
    monkeypatch.setenv(YAML, "true")
    text = _yaml(400)
    cut = formatters._truncate_tool_result_for_llm(text, 6000, tool="k8s_get_resource_yaml")
    assert cut.endswith(CUT + "\n" + LINE)
    assert len(cut) == 6000 + len(CUT)  # the length a cut result had
    assert text.startswith(cut[: 6000 - len(LINE) - 1])
    # cut again, as a result in one JSON object is, it still ends with the line
    assert formatters._truncate_tool_result_for_llm(cut, 2000, tool="k8s_get_resource_yaml").endswith(CUT + "\n" + LINE)
    # a short one, another tool's result and one without the line are as before
    short = _yaml(3)
    assert formatters._truncate_tool_result_for_llm(short, 6000, tool="k8s_get_resource_yaml") == short
    assert formatters._truncate_tool_result_for_llm(text, 6000, tool="k8s_describe_resource") == text[:6000] + CUT
    none = _yaml(400, last="status: {}")
    assert formatters._truncate_tool_result_for_llm(none, 6000, tool="k8s_get_resource_yaml") == none[:6000] + CUT


@pytest.mark.parametrize("limit", range(1, 400))
def test_on_a_cut_never_takes_more_than_a_cut_did(monkeypatch, limit):
    monkeypatch.setenv(YAML, "true")
    text = _yaml(400)
    assert len(formatters._truncate_tool_result_for_llm(text, limit, tool="k8s_get_resource_yaml")) == limit + len(CUT)


def test_on_the_line_is_in_the_one_json_object_too(monkeypatch):
    monkeypatch.setenv(YAML, "true")
    monkeypatch.setenv("AI_TOOL_RESULTS_JSON", "true")
    text = formatters._truncate_tool_result_for_llm(_yaml(400), limits.TOOL_RESULT_CHARS, tool="k8s_get_resource_yaml")
    out = tool_results.for_model("k8s_get_resource_yaml", text, limits.TOOL_RESULT_CHARS)
    assert len(out) <= limits.TOOL_RESULT_CHARS
    assert json.loads(out)["result"].endswith(LINE)
