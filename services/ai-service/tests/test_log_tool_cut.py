"""The model's cut of a tool result. A log ends with its newest line, so a log tool keeps the end; every other tool keeps
the start, which is where tool-server puts the counts."""
import json

import pytest

from app.services.ai import formatters

MARKER_END = "... (truncated for LLM) ..."


def _log(lines: int) -> str:
    return "\n".join(f"2026-11-07T00:00:{i:06d}Z line {i} " + "x" * 40 for i in range(lines))


def test_a_pods_log_keeps_the_newest_lines():
    log = _log(1000)
    cut = formatters._truncate_tool_result_for_llm(log, 6000, tool="k8s_get_pod_logs")
    assert cut.endswith(log.splitlines()[-1])
    assert log.splitlines()[0] not in cut


def test_a_pods_log_says_what_it_left_out_and_starts_at_a_whole_line():
    log = _log(1000)
    cut = formatters._truncate_tool_result_for_llm(log, 6000, tool="k8s_get_pod_logs")
    marker, first, *_ = cut.split("\n")
    assert "earlier lines" in marker
    assert first in log.splitlines()


def test_a_pods_log_stays_near_the_models_length():
    cut = formatters._truncate_tool_result_for_llm(_log(1000), 1500, tool="k8s_get_pod_logs")
    assert len(cut) <= 1500 + 100


def test_one_long_line_keeps_its_end():
    line = "a" * 3000 + "THE-END"
    cut = formatters._truncate_tool_result_for_llm(line, 1000, tool="k8s_get_pod_logs")
    assert cut.endswith("THE-END")
    assert len(cut) <= 1000 + 100


def test_a_log_that_fits_is_left_as_it_is():
    log = _log(3)
    assert formatters._truncate_tool_result_for_llm(log, 6000, tool="k8s_get_pod_logs") == log


@pytest.mark.parametrize(
    "tool,field,head",
    [
        ("logfiles", "content", {"path": "/var/log/app/app.log", "container": "app", "lines": 2000, "truncated": False}),
        ("nodes_log", "text", {"node": "n1", "source": "kubelet", "lines_returned": 2000}),
    ],
)
def test_a_log_inside_json_keeps_the_rest_and_the_newest_lines(tool, field, head):
    log = _log(2000)
    answer = json.dumps({**head, field: log}, indent=2)
    cut = formatters._truncate_tool_result_for_llm(answer, 6000, tool=tool)
    read = json.loads(cut)
    for key, value in head.items():
        if key != "truncated":
            assert read[key] == value
    assert read[field].endswith(log.splitlines()[-1])
    assert log.splitlines()[0] not in read[field]
    assert read["truncated"] is True
    assert len(cut) <= 6000 + 200


@pytest.mark.parametrize("tool", ["logfiles", "nodes_log"])
def test_quotes_and_line_breaks_in_a_log_do_not_push_it_past_the_length(tool):
    log = "\n".join('{"level":"error","msg":"quoted \\"value\\" here"}' for _ in range(2000))
    field = "content" if tool == "logfiles" else "text"
    cut = formatters._truncate_tool_result_for_llm(json.dumps({field: log}, indent=2), 2000, tool=tool)
    assert len(cut) <= 2000 + 200
    assert json.loads(cut)[field].endswith('here"}')


def test_a_list_of_log_files_is_not_a_log():
    answer = json.dumps({"files": [{"path": f"/var/log/{i}.log", "size": i} for i in range(1000)]}, indent=2)
    cut = formatters._truncate_tool_result_for_llm(answer, 1500, tool="logfiles")
    assert cut == answer[:1500] + "\n" + MARKER_END


@pytest.mark.parametrize("tool", ["logsearch", "loki_query", "k8s_get_resources", None])
def test_other_tools_keep_the_start(tool):
    text = "x" * 9000
    assert formatters._truncate_tool_result_for_llm(text, 1500, tool=tool) == "x" * 1500 + "\n" + MARKER_END
