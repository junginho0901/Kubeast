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


# The table and the draft are shown on the screen and handed to the model, so both are written in the UI
# language ("en" or "ko"); numbers, names and flag identifiers are the same in both.
FLAG_TEXT = {
    "en": {
        "cpu_over": "CPU request is at least double the usage-based recommendation",
        "cpu_under": "CPU usage exceeds the request (throttling/eviction risk)",
        "mem_over": "memory request is at least double the usage-based recommendation",
        "mem_under": "memory usage exceeds the request (OOM/eviction risk)",
        "no_cpu_request": "no CPU request (BestEffort scheduling, no guaranteed share)",
        "no_mem_request": "no memory request (BestEffort scheduling, first to be evicted)",
        "no_mem_limit": "no memory limit (a leak can take the node down)",
    },
    "ko": {
        "cpu_over": "CPU request가 사용량 기반 추천값의 2배 이상",
        "cpu_under": "CPU 사용량이 request를 넘음 (스로틀링·축출 위험)",
        "mem_over": "메모리 request가 사용량 기반 추천값의 2배 이상",
        "mem_under": "메모리 사용량이 request를 넘음 (OOM·축출 위험)",
        "no_cpu_request": "CPU request 없음 (BestEffort 스케줄링, 보장 몫 없음)",
        "no_mem_request": "메모리 request 없음 (BestEffort 스케줄링, 가장 먼저 축출)",
        "no_mem_limit": "메모리 limit 없음 (누수 하나로 Node가 멈출 수 있음)",
    },
}

SOURCE_TEXT = {
    "en": {
        "prometheus": "Prometheus over the last {window}h (CPU = 95th percentile of the 5m rate, memory = peak working set)",
        "metrics-server": "metrics-server, one instant sample (no history: treat usage as a snapshot)",
        "none": "no usage data (neither Prometheus nor metrics-server answered)",
    },
    "ko": {
        "prometheus": "Prometheus 최근 {window}시간 (CPU = 5분 rate의 95퍼센타일, 메모리 = 최대 working set)",
        "metrics-server": "metrics-server 순간값 1회 (이력 없음: 사용량은 한 시점 값)",
        "none": "사용량 데이터 없음 (Prometheus·metrics-server 모두 응답 없음)",
    },
}

TEXT = {
    "en": {
        "title": "Observed data",
        "source": "Usage source",
        "count": "Workload containers: {rows}, pods: {pods}",
        "totals": "Totals (all pods): CPU request {cpu} → recommended {cpu_rec}; memory request {mem} → recommended {mem_rec}",
        "head": "| workload | container | pods | cpu req/lim | cpu usage | cpu recommend | mem req/lim | mem usage | mem recommend | flags |",
        "numbers": "request {req}, usage {use}, recommended {rec}",
        "start": "start from {rec}",
    },
    "ko": {
        "title": "관측 데이터",
        "source": "사용량 출처",
        "count": "워크로드 컨테이너 {rows}개, Pod {pods}개",
        "totals": "합계(전체 Pod): CPU request {cpu} → 추천 {cpu_rec}; 메모리 request {mem} → 추천 {mem_rec}",
        "head": "| 워크로드 | 컨테이너 | Pod | CPU req/lim | CPU 사용량 | CPU 추천 | 메모리 req/lim | 메모리 사용량 | 메모리 추천 | 플래그 |",
        "numbers": "request {req}, 사용량 {use}, 추천 {rec}",
        "start": "{rec}부터 시작",
    },
}


def ui_lang(lang: Optional[str]) -> str:
    """The UI language the request named: "ko" for Korean, "en" otherwise."""
    return "ko" if (lang or "").lower().startswith("ko") else "en"


# The heading the screen shows between the table and the model's answer.
ANSWER_HEADING = {"en": "## Optimization suggestions (AI)", "ko": "## 최적화 제안 (AI)"}

SYSTEM_TEXT = {
    "en": "You are a Kubernetes resource optimization expert. Base every statement on the observed data.",
    "ko": "당신은 Kubernetes 리소스 최적화 전문가입니다. 반드시 관측 데이터에 근거해 답하세요.",
}

# {source} is TEXT[lang]["source"], the label of the table's usage-source line.
PROMPT_TEXT = {
    "en": """
    Below is the observed data (a table) of a Kubernetes namespace. k8s-service computed the numbers; the recommendation is CPU = 95th percentile of usage, memory = peak usage + 15%. From this table, explain why the numbers came out this way and what to change first.

    Required:
    - Back each suggestion with the workload names and numbers from the table (request, usage, recommend, flags).
    - Read the '{source}' line and state its limit in your own words: with metrics-server it is one instant value and may have missed the peak; with no usage data, suggest a way to observe usage before any numbers.
    - Do not copy the table's header lines or the draft's sentences as they are; write them again in your own words.
    - Anything not in the table is "needs checking"; do not guess.
    - Keep the numbers and recommendations of the 'Draft (rules-based)' below **unchanged**; improve only the wording and structure.

Observed data (markdown):
{observed}

Draft (rules-based, keep numbers unchanged):
{draft}

Output:
- Markdown
- High/Medium/Low priority
- Each item: (effect: cost/performance/stability) + evidence + an example (short kubectl)

Forbidden:
- Do not wrap the whole answer in a code fence such as ```markdown ... ``` (the UI would render it as a code block).
- Do not start the answer with ```.
""",
    "ko": """
    아래는 Kubernetes 네임스페이스의 관측 데이터(표)입니다. 표의 수치는 k8s-service가 계산한 것이고, 추천값은 CPU = 사용량 95퍼센타일, 메모리 = 최대 사용량 + 15%입니다. 이 표를 근거로 "왜 이런 수치가 나왔는지"와 "무엇부터 바꿀지"를 설명하세요.

    필수:
    - 제안에 반드시 표의 워크로드명/수치(request, 사용량, 추천, 플래그)를 인용해서 근거를 달아주세요.
    - '{source}' 줄을 읽고 그 한계를 자기 말로 말하세요: metrics-server면 순간값이라 피크를 못 봤을 수 있고, 사용량이 없으면 수치 추천 대신 관측 수단부터 제안하세요.
    - 표의 머리말 줄이나 초안 문장을 그대로 옮기지 말고, 자기 말로 다시 쓰세요.
    - 표에 없는 내용은 "추가 확인 필요"로 처리하고 추측하지 마세요.
    - 아래 'Draft (rules-based)'의 수치/추천값은 **바꾸지 말고** 문장/구조만 다듬어 주세요.

Observed data (markdown):
{observed}

Draft (rules-based, keep numbers unchanged):
{draft}

출력:
- 마크다운
- High/Medium/Low 우선순위
- 각 항목에 (효과: 비용/성능/안정성) + 근거 + 적용 예시(kubectl 짧게)

금지:
- 응답 전체를 ```markdown ... ``` 같은 코드 펜스로 감싸지 마세요. (그렇게 하면 UI에서 마크다운 렌더가 코드블록으로 깨집니다)
- 최상단을 ```로 시작하지 마세요.
""",
}


def _m(v: Optional[int]) -> str:
    return "-" if v is None else f"{v}m"


def _mi(v: Optional[int]) -> str:
    return "-" if v is None else f"{int(round(v / (1 << 20)))}Mi"


def _req(v: int, fmt) -> str:
    return fmt(v) if v else "-"


def render_optimization_table(data: Dict, lang: str = "en") -> str:
    """Markdown: header lines + one row per workload container."""
    text = TEXT[ui_lang(lang)]
    namespace = data.get("namespace", "")
    source = str(data.get("source") or "none")
    window = data.get("window_hours")
    rows: List[Dict] = data.get("rows") or []
    totals = data.get("totals") or {}

    lines = [
        f"## {text['title']} (`{namespace}`)",
        f"- {text['source']}: {SOURCE_TEXT[ui_lang(lang)].get(source, source).format(window=window)}",
        f"- {text['count'].format(rows=len(rows), pods=totals.get('pods', 0))}",
    ]
    if source != "none" and totals.get("cpu_request_m") is not None:
        lines.append("- " + text["totals"].format(
            cpu=_m(totals.get("cpu_request_m")), cpu_rec=_m(totals.get("cpu_recommend_m")),
            mem=_mi(totals.get("mem_request_bytes")), mem_rec=_mi(totals.get("mem_recommend_bytes")),
        ))
    lines += [
        "",
        text["head"],
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


def draft_from_flags(data: Dict, lang: str = "en") -> str:
    """One line per flagged row, with the numbers the model must keep."""
    words, flag_text = TEXT[ui_lang(lang)], FLAG_TEXT[ui_lang(lang)]
    lines: List[str] = []
    for r in data.get("rows") or []:
        flags = r.get("flags") or []
        if not flags:
            continue
        name = f"{r.get('kind')}/{r.get('name')} ({r.get('container')})"
        parts = []
        for f in flags:
            text = flag_text.get(f, f)
            if f in ("cpu_over", "cpu_under"):
                text += ": " + words["numbers"].format(req=_m(r.get("cpu_request_m")), use=_m(r.get("cpu_usage_m")), rec=_m(r.get("cpu_recommend_m")))
            elif f in ("mem_over", "mem_under"):
                text += ": " + words["numbers"].format(req=_mi(r.get("mem_request_bytes")), use=_mi(r.get("mem_usage_bytes")), rec=_mi(r.get("mem_recommend_bytes")))
            elif f == "no_cpu_request" and r.get("cpu_recommend_m") is not None:
                text += ": " + words["start"].format(rec=_m(r.get("cpu_recommend_m")))
            elif f == "no_mem_request" and r.get("mem_recommend_bytes") is not None:
                text += ": " + words["start"].format(rec=_mi(r.get("mem_recommend_bytes")))
            parts.append(text)
        lines.append(f"- `{name}`: " + "; ".join(parts))
    return "\n".join(lines)


async def build_optimization_observations(service: "AIService", namespace: str, lang: str = "en") -> Dict[str, str]:
    data = await service.k8s_service.get_optimization(namespace)
    return {
        "observations_md": render_optimization_table(data, lang),
        "observations_text": json.dumps(data, ensure_ascii=False),
        "action_plan_md": draft_from_flags(data, lang),
    }
