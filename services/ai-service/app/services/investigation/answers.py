"""What a tool's answer holds, as the outcome's check reads it (features.alertInvestigation.verdict, investigation/verdict.py).

An answer repeats what was asked: the name in a not_found, the pod in an empty query's PromQL. So a call that read nothing
(unread()) or whose answer holds nothing (empty()) shows no symptom, no cause and no object, whatever names are in its
text. The answer of a raw-text tool (tool_results.RAW_TEXT_TOOLS) is what a container or the cluster wrote: a log line that
is a JSON object with an `error` or a `status` is a log line, and only an object of the shape tool-server or ai-service
makes is an answer of theirs (raw_outcome(), which the chat's row reads too, streaming.read_outcome). Nothing here but
no_log() and log_text() runs with the verdict off."""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from app.services.ai.tool_results import RAW_TEXT_TOOLS

# Statuses a tool answers with in place of a read (tool-server; container_required also ai-service's dispatch). A Helm
# release's own status, as "failed", is none of them.
UNREAD = frozenset({"unavailable", "not_found", "unknown_kind", "container_required", "no_previous", "no_log", "too_large", "unknown_field"})

# The keys beside status that tool-server writes for a raw-text tool (notfound.go, secret_read.go): (always, sometimes).
_RAW_SHAPES: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    "not_found": (frozenset({"kind", "name", "namespace", "similar", "searched", "hint"}), frozenset({"namespace_exists", "searched_truncated"})),
    "unknown_kind": (frozenset({"kind", "similar_kinds", "hint"}), frozenset()),
    "container_required": (frozenset({"pod", "namespace", "containers", "hint"}), frozenset()),
    "no_previous": (frozenset({"pod", "namespace", "container", "hint"}), frozenset()),
    "no_log": (frozenset({"pod", "namespace", "reason", "hint"}), frozenset({"container", "containers"})),
    "unavailable": (frozenset({"feature", "reason", "alternative"}), frozenset()),
    "forbidden": (frozenset({"reason", "hint"}), frozenset({"resource_type"})),
}

# permissions.namespace_scope_error: a grant limited to namespaces, refused before tool-server.
_GRANT = re.compile(r"forbidden: .* your grant on ")

# The read tools whose answer lists what was found, so that an empty list is nothing found. Others answer about the one
# thing asked (what a network policy allows, a release), where an empty list says something.
_LISTS = frozenset({
    "alerts_inbox", "alerts_list", "anomaly_rank", "get_pod_metrics", "gitops_status", "issues", "k8s_count", "k8s_get_events",
    "k8s_get_resources", "k8s_jq_query", "k8s_tabular_query", "logfiles", "logsearch", "loki_patterns", "loki_query",
    "network_drops", "network_flows", "network_top_flows", "policy_reports", "prometheus_query", "resource_graph",
    "storage_summary", "timeline", "traces_compare", "traces_get", "traces_metrics", "traces_search",
})
# Keys of such an answer whose lists are about the call: what was searched, not read or may be meant, where to look.
_ABOUT = frozenset({"cluster_ids", "clusters", "columns", "console_links", "kinds", "namespaces", "not_read", "not_run", "not_served", "notes",
                    "partial", "refused", "scope", "searched", "similar", "similar_kinds", "skipped", "sources", "warnings"})
# Its counts of what was found (a nil list is null in JSON, its count 0).
_COUNTS = ("count", "items_total", "matches_found", "returned", "rows_total", "series", "seriesTotal", "shown", "total", "traces")

_NONE_IN_TABLE = re.compile(r"^No resources found", re.M)
# kubectl's answer of no object without a table (-o name) is (ai.toolResultDetails) the one line that says why.
_NONE_NAMED = re.compile(r"(Nothing of this kind exists now in what was read|No event matched)\. .+")
# k8s_tabular_query's first line, of a list that was read whole.
_NO_ROWS = re.compile(r"# .+: 0 rows \(none\)")
# k8s_get_pod_logs: a grep without a match, or (ai.toolResultDetails) a log without a line, is comment lines alone, after
# the line that says the front of the log was cut off.
_NO_LINE = re.compile(r"# (grep .*: 0 of \d+ lines matched|No line was read:)")
_SAYS_NO_LINE = re.compile(r"# No line was read: .+\n?")
_NO_LOG_OF = re.compile(r"\n# No (?:previous log of [^\n]+ \(not restarted\)|log of [^\n]+ \((?:waiting to start|not available|terminated)[^\n]*\))\.\n?\Z")
_LOG_CUT = re.compile(r"… \[older lines cut by tool-server: .+\]")


def parsed(raw: Any) -> Optional[dict]:
    """The answer as a JSON object, None for any other answer."""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, RecursionError):
        return None
    return data if isinstance(data, dict) else None


def raw_outcome(tool: str, raw: Any) -> tuple[Optional[str], Optional[str]]:
    """(error, status) of a raw-text tool's answer, as streaming.tool_outcome gives them of the others: only of an object
    ai-service's dispatch or tool-server made, not of text that happens to be a JSON object."""
    data = parsed(raw)
    if data is None:
        return None, None
    error = data.get("error")
    if isinstance(error, str) and raw == json.dumps({"error": error}, ensure_ascii=False) and error.startswith(
            (f"Error in {tool}: ", f"권한 없음: '{tool}'")):
        return error[:300], None
    message = data.get("message")
    if isinstance(message, str) and raw == json.dumps({"status": "forbidden", "message": message}, ensure_ascii=False) and _GRANT.match(message):
        return "forbidden", "forbidden"
    status = data.get("status")
    shape = _RAW_SHAPES.get(status) if isinstance(status, str) else None
    if shape is None:
        return None, None
    always, sometimes = shape
    keys = set(data) - {"status"}
    if not always <= keys or keys - always - sometimes:
        return None, None
    return (status if status == "forbidden" else None), status


def no_log(tool: str, raw: Any) -> bool:
    """Whether a read of a pod's log is tool-server's answer that the node had no log to give: the kubelet's own words in
    place of one. The runner asks this and log_text() with the verdict off too."""
    return tool == "k8s_get_pod_logs" and raw_outcome(tool, raw)[1] == "no_log"


def log_text(tool: str, text: str) -> str:
    """What the model reads of a call without tool-server's own line of which containers' logs held or have no line: the
    containers, and the file in the kubelet's words, that it names are not in a log."""
    if tool != "k8s_get_pod_logs":
        return text
    return "" if _SAYS_NO_LINE.fullmatch(text) else _NO_LOG_OF.sub("", text)


def unread(tool: str, raw: Any, status: Optional[str]) -> Optional[str]:
    """The status of an answer that read nothing, None for one that read. A kubectl object's own status is none of
    these. `status`: the answer's, by tool_outcome or raw_outcome."""
    if status == "failed" and tool == "logfiles":  # its command ran and could not read the file
        return status
    if status not in UNREAD or "apiVersion" in (parsed(raw) or {}):
        return None
    return status


def unread_detail(tool: str, raw: Any) -> str:
    """tool-server's reason in an answer that read nothing: of a feature's answer only, and none of a raw-text tool's."""
    data = parsed(raw) or {}
    if tool in RAW_TEXT_TOOLS or not isinstance(data.get("feature"), str):
        return ""
    return data["reason"] if isinstance(data.get("reason"), str) else ""


def _lists(value: Any) -> tuple[bool, bool]:
    """(whether there is a list in a JSON value, whether one of them holds something), the lists about the call aside."""
    if isinstance(value, list):
        return True, bool(value)
    found = held = False
    for key, part in (value.items() if isinstance(value, dict) else ()):
        if key not in _ABOUT:
            one, some = _lists(part)
            found, held = found or one, held or some
    return found, held


def _none_in_text(tool: str, text: str) -> bool:
    """Whether a list's answer that is no JSON holds nothing."""
    if tool == "k8s_tabular_query" and _NO_ROWS.fullmatch(text.split("\n", 1)[0].rstrip()):
        return True
    return bool(_NONE_IN_TABLE.search(text)) or (tool == "k8s_get_resources" and _NONE_NAMED.fullmatch(text) is not None)


def empty(tool: str, raw: Any) -> bool:
    """Whether an answer that read holds nothing: no text, kubectl's "No resources found", no row, no log line, or of a
    tool that lists what was found, only empty lists."""
    text = raw.strip() if isinstance(raw, str) else None
    if text is not None and text in ("", "null", "[]", "{}"):
        return True
    if tool in RAW_TEXT_TOOLS:
        lines = [line for line in (text or "").splitlines() if line.strip()]
        if lines and _LOG_CUT.fullmatch(lines[0]):
            lines = lines[1:]
        return tool == "k8s_get_pod_logs" and bool(lines and _NO_LINE.match(lines[0])) and all(line.startswith("# ") for line in lines)
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, RecursionError):
        return _none_in_text(tool, text or "")
    if isinstance(data, list):
        return not data
    if not isinstance(data, dict) or tool not in _LISTS or isinstance(data.get("metadata"), dict) and not str(data.get("kind")).endswith("List"):
        return False
    if isinstance(data.get("empty_reason"), str) and data["empty_reason"]:
        return True
    if tool == "logfiles" and isinstance(data.get("content"), str):
        return not data["content"].strip()
    if tool == "gitops_status" and isinstance(data.get("counts"), dict) and isinstance(data["counts"].get("sync"), dict):
        # its counts are of every application the call is about, those only_problems leaves out of the list too
        return not any(data["counts"]["sync"].values())
    try:
        found, held = _lists(data)
    except RecursionError:
        return False
    counts = [data[key] for key in _COUNTS if isinstance(data.get(key), (int, float)) and not isinstance(data.get(key), bool)]
    return not held and (found or 0 in counts) and not any(counts)
