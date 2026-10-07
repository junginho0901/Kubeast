"""
Observed data for the optimization suggestion.

k8s-service computes the table (GET /optimization: requests and limits per
workload container, usage over the window, the request that usage suggests,
flags). This module renders it as markdown for the UI and the model, and
writes a rules-based draft from the flags. The model explains the numbers;
it does not size anything itself.
"""
from typing import TYPE_CHECKING, Dict, List, Optional
import json

if TYPE_CHECKING:
    from app.services.ai_service import AIService


FLAG_TEXT = {
    "cpu_over": "CPU request is at least double the usage-based recommendation",
    "cpu_under": "CPU usage exceeds the request (throttling/eviction risk)",
    "mem_over": "memory request is at least double the usage-based recommendation",
    "mem_under": "memory usage exceeds the request (OOM/eviction risk)",
    "no_cpu_request": "no CPU request (BestEffort scheduling, no guaranteed share)",
    "no_mem_request": "no memory request (BestEffort scheduling, first to be evicted)",
    "no_mem_limit": "no memory limit (a leak can take the node down)",
}

SOURCE_TEXT = {
    "prometheus": "Prometheus over the last {window}h (CPU = 95th percentile of the 5m rate, memory = peak working set)",
    "metrics-server": "metrics-server, one instant sample (no history: treat usage as a snapshot)",
    "none": "no usage data (neither Prometheus nor metrics-server answered)",
}


def _m(v: Optional[int]) -> str:
    return "-" if v is None else f"{v}m"


def _mi(v: Optional[int]) -> str:
    return "-" if v is None else f"{int(round(v / (1 << 20)))}Mi"


def _req(v: int, fmt) -> str:
    return fmt(v) if v else "-"


def render_optimization_table(data: Dict) -> str:
    """Markdown: header lines + one row per workload container."""
    namespace = data.get("namespace", "")
    source = str(data.get("source") or "none")
    window = data.get("window_hours")
    rows: List[Dict] = data.get("rows") or []
    totals = data.get("totals") or {}

    lines = [
        f"## Observed data (`{namespace}`)",
        f"- Usage source: {SOURCE_TEXT.get(source, source).format(window=window)}",
        f"- Workload containers: {len(rows)}, pods: {totals.get('pods', 0)}",
    ]
    if source != "none" and totals.get("cpu_request_m") is not None:
        lines.append(
            f"- Totals (all pods): CPU request {_m(totals.get('cpu_request_m'))} → recommended {_m(totals.get('cpu_recommend_m'))}; "
            f"memory request {_mi(totals.get('mem_request_bytes'))} → recommended {_mi(totals.get('mem_recommend_bytes'))}"
        )
    lines += [
        "",
        "| workload | container | pods | cpu req/lim | cpu usage | cpu recommend | mem req/lim | mem usage | mem recommend | flags |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for r in rows:
        lines.append(
            f"| `{r.get('kind')}/{r.get('name')}` | {r.get('container')} | {r.get('pods')} "
            f"| {_req(r.get('cpu_request_m'), _m)}/{_req(r.get('cpu_limit_m'), _m)} | {_m(r.get('cpu_usage_m'))} | {_m(r.get('cpu_recommend_m'))} "
            f"| {_req(r.get('mem_request_bytes'), _mi)}/{_req(r.get('mem_limit_bytes'), _mi)} | {_mi(r.get('mem_usage_bytes'))} | {_mi(r.get('mem_recommend_bytes'))} "
            f"| {', '.join(r.get('flags') or []) or '-'} |"
        )
    return "\n".join(lines)


def draft_from_flags(data: Dict) -> str:
    """One line per flagged row, with the numbers the model must keep."""
    lines: List[str] = []
    for r in data.get("rows") or []:
        flags = r.get("flags") or []
        if not flags:
            continue
        name = f"{r.get('kind')}/{r.get('name')} ({r.get('container')})"
        parts = []
        for f in flags:
            text = FLAG_TEXT.get(f, f)
            if f in ("cpu_over", "cpu_under"):
                text += f": request {_m(r.get('cpu_request_m'))}, usage {_m(r.get('cpu_usage_m'))}, recommended {_m(r.get('cpu_recommend_m'))}"
            elif f in ("mem_over", "mem_under"):
                text += f": request {_mi(r.get('mem_request_bytes'))}, usage {_mi(r.get('mem_usage_bytes'))}, recommended {_mi(r.get('mem_recommend_bytes'))}"
            elif f == "no_cpu_request" and r.get("cpu_recommend_m") is not None:
                text += f": start from {_m(r.get('cpu_recommend_m'))}"
            elif f == "no_mem_request" and r.get("mem_recommend_bytes") is not None:
                text += f": start from {_mi(r.get('mem_recommend_bytes'))}"
            parts.append(text)
        lines.append(f"- `{name}`: " + "; ".join(parts))
    return "\n".join(lines)


async def build_optimization_observations(service: "AIService", namespace: str) -> Dict[str, str]:
    data = await service.k8s_service.get_optimization(namespace)
    return {
        "observations_md": render_optimization_table(data),
        "observations_text": json.dumps(data, ensure_ascii=False),
        "action_plan_md": draft_from_flags(data),
    }
