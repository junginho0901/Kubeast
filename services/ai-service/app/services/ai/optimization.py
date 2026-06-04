"""
최적화 제안용 관측 데이터 요약 생성기.

ai_service.AIService._build_optimization_observations 에서 추출.
service.k8s_service 를 통해 클러스터 데이터를 수집하고, quantities.py 의
순수 헬퍼로 수치를 파싱한다.

호출자는 AIService._build_optimization_observations 래퍼를 통해 진입한다.
"""
from typing import TYPE_CHECKING, Dict, List, Optional
import json

from app.services.ai.quantities import (
    extract_image_tag_flag,
    labels_match_selector,
    median_int,
    parse_cpu_quantity_to_m,
    parse_memory_quantity_to_mi,
    round_up_int,
)

if TYPE_CHECKING:
    from app.services.ai_service import AIService


async def build_optimization_observations(service: "AIService", namespace: str) -> Dict[str, str]:
    """최적화 제안용 관측 데이터 요약 생성 (LLM 입력 + UI 표시용)"""
    overview = None
    try:
        overview = await service.k8s_service.get_cluster_overview()
    except Exception as e:
        overview = {"error": str(e)}

    deployments = await service.k8s_service.get_deployments(namespace)
    pods = await service.k8s_service.get_pods(namespace)

    pod_metrics: Optional[List[Dict]] = None
    pod_metrics_error: Optional[str] = None
    try:
        pod_metrics = await service.k8s_service.get_pod_metrics(namespace)
    except Exception as e:
        pod_metrics = None
        pod_metrics_error = str(e)

    events: List[Dict] = []
    events_error: Optional[str] = None
    try:
        events = await service.k8s_service.get_events(namespace)
    except Exception as e:
        events_error = str(e)

    deployments_sorted = sorted(
        deployments,
        key=lambda d: len((d.get("selector") or {})),
        reverse=True,
    )

    # Map pod -> deployment by selector (most specific selector wins)
    pod_to_deployment: Dict[str, str] = {}
    deployment_to_pods: Dict[str, List[Dict]] = {d.get("name"): [] for d in deployments_sorted if d.get("name")}
    unmatched_pods: List[Dict] = []
    for pod in pods:
        labels = pod.get("labels") or {}
        matched_name: Optional[str] = None
        for dep in deployments_sorted:
            dep_name = dep.get("name")
            selector = dep.get("selector") or {}
            if not dep_name:
                continue
            if labels_match_selector(labels, selector):
                matched_name = dep_name
                break
        if matched_name:
            pod_to_deployment[pod.get("name", "")] = matched_name
            deployment_to_pods.setdefault(matched_name, []).append(pod)
        else:
            unmatched_pods.append(pod)

    metrics_by_pod: Dict[str, Dict] = {}
    if pod_metrics:
        for item in pod_metrics:
            key = f"{item.get('namespace')}/{item.get('name')}"
            metrics_by_pod[key] = item

    metrics_window_sample: Optional[str] = None
    metrics_timestamp_max: Optional[str] = None
    if pod_metrics:
        windows = [str(m.get("window")) for m in pod_metrics if m.get("window")]
        if windows:
            # "30s" 같은 값이 대부분이므로 샘플 1개만 표기(가장 흔한 값 우선)
            counts: Dict[str, int] = {}
            for w in windows:
                counts[w] = counts.get(w, 0) + 1
            metrics_window_sample = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[0][0]

        timestamps = [str(m.get("timestamp")) for m in pod_metrics if m.get("timestamp")]
        if timestamps:
            # ISO8601이면 max timestamp를 표기(파싱 실패 시 문자열 max로 fallback)
            try:
                from datetime import datetime

                parsed = []
                for ts in timestamps:
                    parsed.append(datetime.fromisoformat(ts.replace("Z", "+00:00")))
                metrics_timestamp_max = max(parsed).isoformat()
            except Exception:
                metrics_timestamp_max = max(timestamps)

    def pod_resource_totals(pod: Dict):
        cpu_req_m_vals: List[int] = []
        cpu_lim_m_vals: List[int] = []
        mem_req_mi_vals: List[int] = []
        mem_lim_mi_vals: List[int] = []
        missing_req_any = 0
        missing_lim_any = 0
        missing_cpu_req = 0
        missing_mem_req = 0
        missing_cpu_lim = 0
        missing_mem_lim = 0

        for c in (pod.get("containers") or []):
            req = c.get("requests") or {}
            lim = c.get("limits") or {}
            cpu_req_m = parse_cpu_quantity_to_m(req.get("cpu"))
            mem_req_mi = parse_memory_quantity_to_mi(req.get("memory"))
            cpu_lim_m = parse_cpu_quantity_to_m(lim.get("cpu"))
            mem_lim_mi = parse_memory_quantity_to_mi(lim.get("memory"))

            if cpu_req_m is None:
                missing_cpu_req += 1
            if mem_req_mi is None:
                missing_mem_req += 1
            if cpu_lim_m is None:
                missing_cpu_lim += 1
            if mem_lim_mi is None:
                missing_mem_lim += 1

            if cpu_req_m is None or mem_req_mi is None:
                missing_req_any += 1
            if cpu_lim_m is None or mem_lim_mi is None:
                missing_lim_any += 1

            if cpu_req_m is not None:
                cpu_req_m_vals.append(cpu_req_m)
            if cpu_lim_m is not None:
                cpu_lim_m_vals.append(cpu_lim_m)
            if mem_req_mi is not None:
                mem_req_mi_vals.append(mem_req_mi)
            if mem_lim_mi is not None:
                mem_lim_mi_vals.append(mem_lim_mi)

        return {
            "cpu_request_m": sum(cpu_req_m_vals) if cpu_req_m_vals else None,
            "cpu_limit_m": sum(cpu_lim_m_vals) if cpu_lim_m_vals else None,
            "mem_request_mi": sum(mem_req_mi_vals) if mem_req_mi_vals else None,
            "mem_limit_mi": sum(mem_lim_mi_vals) if mem_lim_mi_vals else None,
            "containers_total": len(pod.get("containers") or []),
            "containers_missing_requests": missing_req_any,
            "containers_missing_limits": missing_lim_any,
            "containers_missing_cpu_requests": missing_cpu_req,
            "containers_missing_mem_requests": missing_mem_req,
            "containers_missing_cpu_limits": missing_cpu_lim,
            "containers_missing_mem_limits": missing_mem_lim,
        }

    def pod_usage(pod: Dict):
        key = f"{pod.get('namespace')}/{pod.get('name')}"
        m = metrics_by_pod.get(key)
        if not m:
            return {"cpu_m": None, "mem_mi": None}
        return {
            "cpu_m": parse_cpu_quantity_to_m(m.get("cpu")),
            "mem_mi": parse_memory_quantity_to_mi(m.get("memory")),
            "timestamp": m.get("timestamp"),
            "window": m.get("window"),
        }

    deployment_rows = []
    findings: List[str] = []

    node_count = None
    if isinstance(overview, dict):
        node_count = overview.get("node_count")
    node_count = int(node_count) if isinstance(node_count, (int, float)) else None

    for dep in deployments_sorted[:25]:
        dep_name = dep.get("name")
        if not dep_name:
            continue
        dep_pods = deployment_to_pods.get(dep_name, [])

        restarts = [int(p.get("restart_count") or 0) for p in dep_pods]
        total_restarts = sum(restarts)
        max_restarts = max(restarts) if restarts else 0
        not_ready = 0
        for p in dep_pods:
            ready_str = str(p.get("ready") or "")
            try:
                ready_ok = ready_str and ready_str.split("/")[0] == ready_str.split("/")[1]
            except Exception:
                ready_ok = False
            if not ready_ok:
                not_ready += 1

        per_pod_cpu_req = []
        per_pod_cpu_lim = []
        per_pod_mem_req = []
        per_pod_mem_lim = []
        missing_req_containers = 0
        missing_lim_containers = 0
        missing_cpu_req_containers = 0
        missing_mem_req_containers = 0
        missing_cpu_lim_containers = 0
        missing_mem_lim_containers = 0
        containers_total = 0

        cpu_usage_vals = []
        mem_usage_vals = []

        image_flags = []
        reason_counts: Dict[str, int] = {}
        for p in dep_pods:
            totals = pod_resource_totals(p)
            containers_total += totals["containers_total"]
            missing_req_containers += totals["containers_missing_requests"]
            missing_lim_containers += totals["containers_missing_limits"]
            missing_cpu_req_containers += totals.get("containers_missing_cpu_requests", 0) or 0
            missing_mem_req_containers += totals.get("containers_missing_mem_requests", 0) or 0
            missing_cpu_lim_containers += totals.get("containers_missing_cpu_limits", 0) or 0
            missing_mem_lim_containers += totals.get("containers_missing_mem_limits", 0) or 0
            if totals["cpu_request_m"] is not None:
                per_pod_cpu_req.append(totals["cpu_request_m"])
            if totals["cpu_limit_m"] is not None:
                per_pod_cpu_lim.append(totals["cpu_limit_m"])
            if totals["mem_request_mi"] is not None:
                per_pod_mem_req.append(totals["mem_request_mi"])
            if totals["mem_limit_mi"] is not None:
                per_pod_mem_lim.append(totals["mem_limit_mi"])

            u = pod_usage(p)
            if u.get("cpu_m") is not None:
                cpu_usage_vals.append(int(u["cpu_m"]))
            if u.get("mem_mi") is not None:
                mem_usage_vals.append(int(u["mem_mi"]))

            for c in (p.get("containers") or []):
                img = str(c.get("image") or "")
                if img:
                    image_flags.append(extract_image_tag_flag(img))

                # container state / last_state reasons
                for state_key in ("state", "last_state"):
                    st = c.get(state_key) or {}
                    if not isinstance(st, dict):
                        continue
                    waiting = st.get("waiting") if isinstance(st.get("waiting"), dict) else None
                    if waiting and waiting.get("reason"):
                        reason = str(waiting.get("reason"))
                        reason_counts[reason] = reason_counts.get(reason, 0) + 1
                    terminated = st.get("terminated") if isinstance(st.get("terminated"), dict) else None
                    if terminated and terminated.get("reason"):
                        reason = str(terminated.get("reason"))
                        reason_counts[reason] = reason_counts.get(reason, 0) + 1

        cpu_req_med = median_int(per_pod_cpu_req)
        mem_req_med = median_int(per_pod_mem_req)
        cpu_lim_med = median_int(per_pod_cpu_lim)
        mem_lim_med = median_int(per_pod_mem_lim)

        cpu_usage_avg = int(sum(cpu_usage_vals) / len(cpu_usage_vals)) if cpu_usage_vals else None
        mem_usage_avg = int(sum(mem_usage_vals) / len(mem_usage_vals)) if mem_usage_vals else None

        cpu_util = None
        if missing_cpu_req_containers == 0 and cpu_req_med and cpu_usage_avg is not None and cpu_req_med > 0:
            cpu_util = round(cpu_usage_avg / cpu_req_med * 100, 1)
        mem_util = None
        if missing_mem_req_containers == 0 and mem_req_med and mem_usage_avg is not None and mem_req_med > 0:
            mem_util = round(mem_usage_avg / mem_req_med * 100, 1)

        image_flag = "unknown"
        if image_flags:
            # If any latest/untagged exists, highlight
            if "latest" in image_flags:
                image_flag = "latest"
            elif "untagged" in image_flags:
                image_flag = "untagged"
            else:
                image_flag = "pinned"

        deployment_rows.append(
            {
                "name": dep_name,
                "replicas": dep.get("replicas"),
                "ready": dep.get("ready_replicas"),
                "pods": len(dep_pods),
                "not_ready": not_ready,
                "restarts_total": total_restarts,
                "restarts_max": max_restarts,
                "cpu_req_m": cpu_req_med,
                "cpu_lim_m": cpu_lim_med,
                "mem_req_mi": mem_req_med,
                "mem_lim_mi": mem_lim_med,
                "cpu_usage_m_avg": cpu_usage_avg,
                "mem_usage_mi_avg": mem_usage_avg,
                "cpu_util_pct": cpu_util,
                "mem_util_pct": mem_util,
                "containers_total": containers_total,
                "missing_req_containers": missing_req_containers,
                "missing_lim_containers": missing_lim_containers,
                "missing_cpu_req_containers": missing_cpu_req_containers,
                "missing_mem_req_containers": missing_mem_req_containers,
                "missing_cpu_lim_containers": missing_cpu_lim_containers,
                "missing_mem_lim_containers": missing_mem_lim_containers,
                "image_flag": image_flag,
                "selector": dep.get("selector") or {},
                "reason_counts": reason_counts,
            }
        )

    # Aggregate findings (less spammy than per-deployment repetition)
    def sample(names: List[str], limit: int = 6) -> str:
        if not names:
            return ""
        head = names[:limit]
        suffix = "…" if len(names) > limit else ""
        return ", ".join(f"`{n}`" for n in head) + suffix

    if node_count and node_count >= 2:
        single_replica = [r["name"] for r in deployment_rows if r.get("replicas") == 1]
        if single_replica:
            findings.append(
                f"- replicas=1 deployments: {len(single_replica)}/{len(deployment_rows)} (node_count={node_count}) 예: {sample(single_replica)}"
            )

    missing_resources = [
        r["name"]
        for r in deployment_rows
        if (r.get("missing_req_containers", 0) > 0 or r.get("missing_lim_containers", 0) > 0) and r.get("pods", 0) > 0
    ]
    if missing_resources:
        findings.append(f"- requests/limits 누락 컨테이너가 있는 deployment: {len(missing_resources)} 예: {sample(missing_resources)}")

    missing_cpu_req = [r["name"] for r in deployment_rows if (r.get("missing_cpu_req_containers") or 0) > 0]
    if missing_cpu_req:
        findings.append(f"- cpu requests 누락 컨테이너(부분 누락 포함): {len(missing_cpu_req)} 예: {sample(missing_cpu_req)}")

    missing_mem_req = [r["name"] for r in deployment_rows if (r.get("missing_mem_req_containers") or 0) > 0]
    if missing_mem_req:
        findings.append(f"- memory requests 누락 컨테이너(부분 누락 포함): {len(missing_mem_req)} 예: {sample(missing_mem_req)}")

    missing_cpu_lim = [r["name"] for r in deployment_rows if (r.get("missing_cpu_lim_containers") or 0) > 0]
    if missing_cpu_lim:
        findings.append(f"- cpu limits 누락 컨테이너(부분 누락 포함): {len(missing_cpu_lim)} 예: {sample(missing_cpu_lim)}")

    missing_mem_lim = [r["name"] for r in deployment_rows if (r.get("missing_mem_lim_containers") or 0) > 0]
    if missing_mem_lim:
        findings.append(f"- memory limits 누락 컨테이너(부분 누락 포함): {len(missing_mem_lim)} 예: {sample(missing_mem_lim)}")

    image_issues = [r["name"] for r in deployment_rows if r.get("image_flag") in ("latest", "untagged")]
    if image_issues:
        findings.append(f"- latest/미태깅 이미지 가능성: {len(image_issues)} 예: {sample(image_issues)}")

    # Common runtime issues
    def count_reason(deployment: Dict, reason: str) -> int:
        rc = deployment.get("reason_counts") or {}
        if not isinstance(rc, dict):
            return 0
        return int(rc.get(reason) or 0)

    crashloops = [r["name"] for r in deployment_rows if count_reason(r, "CrashLoopBackOff") > 0]
    if crashloops:
        findings.append(f"- CrashLoopBackOff 감지: {len(crashloops)} 예: {sample(crashloops)}")

    oomkilled = [r["name"] for r in deployment_rows if count_reason(r, "OOMKilled") > 0]
    if oomkilled:
        findings.append(f"- OOMKilled 감지: {len(oomkilled)} 예: {sample(oomkilled)}")

    imagepull = [
        r["name"]
        for r in deployment_rows
        if count_reason(r, "ImagePullBackOff") > 0 or count_reason(r, "ErrImagePull") > 0
    ]
    if imagepull:
        findings.append(f"- ImagePullBackOff/ErrImagePull 감지: {len(imagepull)} 예: {sample(imagepull)}")

    not_ready_deps = [r["name"] for r in deployment_rows if (r.get("not_ready") or 0) > 0]
    if not_ready_deps:
        findings.append(f"- Ready 아닌 pod가 있는 deployment: {len(not_ready_deps)} 예: {sample(not_ready_deps)}")

    high_restarts = [r["name"] for r in deployment_rows if (r.get("restarts_total") or 0) >= 3]
    if high_restarts:
        findings.append(f"- 재시작(>=3) 발생 deployment: {len(high_restarts)} 예: {sample(high_restarts)}")

    cpu_over = [
        r["name"]
        for r in deployment_rows
        if r.get("cpu_util_pct") is not None and (r.get("cpu_req_m") or 0) >= 200 and float(r["cpu_util_pct"]) < 20
    ]
    if cpu_over:
        findings.append(f"- CPU request 과대 가능성(util<20% & req>=200m): {len(cpu_over)} 예: {sample(cpu_over)}")

    mem_over = [
        r["name"]
        for r in deployment_rows
        if r.get("mem_util_pct") is not None and (r.get("mem_req_mi") or 0) >= 256 and float(r["mem_util_pct"]) < 20
    ]
    if mem_over:
        findings.append(f"- Memory request 과대 가능성(util<20% & req>=256Mi): {len(mem_over)} 예: {sample(mem_over)}")

    mem_hot = [r["name"] for r in deployment_rows if r.get("mem_util_pct") is not None and float(r["mem_util_pct"]) >= 90]
    if mem_hot:
        findings.append(f"- Memory request 대비 사용량 높음(util>=90%): {len(mem_hot)} 예: {sample(mem_hot)}")

    cpu_hot = [r["name"] for r in deployment_rows if r.get("cpu_util_pct") is not None and float(r["cpu_util_pct"]) >= 90]
    if cpu_hot:
        findings.append(f"- CPU request 대비 사용량 높음(util>=90%): {len(cpu_hot)} 예: {sample(cpu_hot)}")

    # Events: keep Warning-ish events only, and trim
    event_lines: List[str] = []
    if events:
        warnings = []
        for ev in events:
            if not isinstance(ev, dict):
                continue
            t = str(ev.get("type") or "")
            reason = str(ev.get("reason") or "")
            msg = str(ev.get("message") or "")
            if t.lower() in ("warning",) or reason in ("FailedScheduling", "FailedMount", "Failed", "BackOff", "ErrImagePull", "ImagePullBackOff"):
                warnings.append((t, reason, msg))
        for t, reason, msg in warnings[:12]:
            trimmed = (msg[:180] + "…") if len(msg) > 180 else msg
            event_lines.append(f"- [{t or 'Event'}] {reason}: {trimmed}")

    # Build markdown
    header_lines = [
        f"## Observed data (`{namespace}`)",
    ]
    if isinstance(overview, dict) and overview.get("error"):
        header_lines.append(f"- Cluster overview: error={overview.get('error')}")
    else:
        if isinstance(overview, dict):
            header_lines.append(f"- Nodes: {overview.get('node_count', 'N/A')}, Cluster version: {overview.get('cluster_version', 'N/A')}")
    header_lines.append(f"- Deployments: {len(deployments)}, Pods: {len(pods)}")
    if pod_metrics_error:
        header_lines.append(f"- Pod metrics: error={pod_metrics_error}")
    else:
        header_lines.append(f"- Pod metrics: {'available' if pod_metrics is not None else 'unavailable'}")
    header_lines.append(
        "- Note: `usage`는 metrics-server **스냅샷(현재값)** 이며, 표의 `usage` 값은 **파드별 스냅샷을 deployment 단위로 평균** 낸 값입니다. `req/lim`은 컨테이너별 합(누락 컨테이너가 있으면 과소추정)입니다."
    )
    if metrics_window_sample or metrics_timestamp_max:
        header_lines.append(
            f"- Pod metrics snapshot info: window={metrics_window_sample or 'N/A'}, timestamp(max)={metrics_timestamp_max or 'N/A'}"
        )
    if events_error:
        header_lines.append(f"- Events: error={events_error}")
    elif event_lines:
        header_lines.append(f"- Warning events (sample): {len(event_lines)}")

    table_lines = [
        "",
        "### Deployments summary",
        "| deployment | replicas(ready) | pods(notReady) | restarts(total/max) | cpu req/lim (m, per-pod) | cpu usage (m, pods avg snapshot) | mem req/lim (Mi, per-pod) | mem usage (Mi, pods avg snapshot) | util cpu/mem (vs req) | image |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for row in deployment_rows:
        replicas = row.get("replicas")
        ready = row.get("ready")
        pods_count = row.get("pods")
        not_ready = row.get("not_ready")
        restarts_total = row.get("restarts_total")
        restarts_max = row.get("restarts_max")
        cpu_req = row.get("cpu_req_m")
        cpu_lim = row.get("cpu_lim_m")
        mem_req = row.get("mem_req_mi")
        mem_lim = row.get("mem_lim_mi")
        cpu_u = row.get("cpu_usage_m_avg")
        mem_u = row.get("mem_usage_mi_avg")
        cpu_util = row.get("cpu_util_pct")
        mem_util = row.get("mem_util_pct")
        util_text = ""
        if cpu_util is not None or mem_util is not None:
            util_text = f"{cpu_util if cpu_util is not None else 'N/A'}%/{mem_util if mem_util is not None else 'N/A'}%"
        image_flag = row.get("image_flag")

        cpu_req_text = cpu_req if cpu_req is not None else "N/A"
        cpu_lim_text = cpu_lim if cpu_lim is not None else "N/A"
        mem_req_text = mem_req if mem_req is not None else "N/A"
        mem_lim_text = mem_lim if mem_lim is not None else "N/A"
        cpu_u_text = cpu_u if cpu_u is not None else "N/A"
        mem_u_text = mem_u if mem_u is not None else "N/A"
        table_lines.append(
            f"| `{row.get('name')}` | {replicas}({ready}) | {pods_count}({not_ready}) | {restarts_total}/{restarts_max} | {cpu_req_text}/{cpu_lim_text} | {cpu_u_text} | {mem_req_text}/{mem_lim_text} | {mem_u_text} | {util_text or 'N/A'} | {image_flag} |"
        )

    md = "\n".join(header_lines + table_lines)
    if event_lines:
        md += "\n\n### Warning events (sample)\n" + "\n".join(event_lines)
    if findings:
        md += "\n\n### Auto findings (based on observed data)\n" + "\n".join(findings[:30])

    # Build deterministic action plan (so "표"와 "제안"이 연결되게)
    def is_probably_control_plane(name: str) -> bool:
        lowered = name.lower()
        keywords = ("operator", "controller", "admission", "webhook", "converter", "crd")
        return any(k in lowered for k in keywords)

    def is_probably_user_facing(name: str) -> bool:
        lowered = name.lower()
        keywords = ("gateway", "ingress", "web", "api", "console", "dashboard")
        return any(k in lowered for k in keywords)

    def fmt_m(value: Optional[int]) -> str:
        return f"{value}m" if isinstance(value, int) else "N/A"

    def fmt_mi(value: Optional[int]) -> str:
        return f"{value}Mi" if isinstance(value, int) else "N/A"

    def rec_cpu_request_m(row: Dict) -> Optional[int]:
        usage = row.get("cpu_usage_m_avg")
        if not isinstance(usage, int) or usage <= 0:
            return None
        # p95가 없으니 보수적으로 avg*2를 권장(최소 50m)
        return round_up_int(max(int(usage * 2), 50), 10)

    def rec_mem_request_mi(row: Dict) -> Optional[int]:
        usage = row.get("mem_usage_mi_avg")
        if not isinstance(usage, int) or usage <= 0:
            return None
        # avg 기반으로 1.5x(최소 128Mi)
        return round_up_int(max(int(usage * 1.5), 128), 64)

    def rec_limit_from_request(request: Optional[int], factor: float, step: int) -> Optional[int]:
        if not isinstance(request, int) or request <= 0:
            return None
        return round_up_int(max(int(request * factor), request), step)

    # Hot/overprovision lists
    hot_mem = sorted(
        [r for r in deployment_rows if isinstance(r.get("mem_util_pct"), (int, float)) and float(r["mem_util_pct"]) >= 90],
        key=lambda r: float(r.get("mem_util_pct") or 0),
        reverse=True,
    )
    hot_cpu = sorted(
        [r for r in deployment_rows if isinstance(r.get("cpu_util_pct"), (int, float)) and float(r["cpu_util_pct"]) >= 90],
        key=lambda r: float(r.get("cpu_util_pct") or 0),
        reverse=True,
    )
    over_cpu = sorted(
        [r for r in deployment_rows if isinstance(r.get("cpu_util_pct"), (int, float)) and float(r["cpu_util_pct"]) < 20 and (r.get("cpu_req_m") or 0) >= 200],
        key=lambda r: float(r.get("cpu_util_pct") or 0),
    )

    missing_resources_rows = [
        r
        for r in deployment_rows
        if (r.get("missing_req_containers", 0) > 0 or r.get("missing_lim_containers", 0) > 0 or r.get("cpu_req_m") is None or r.get("mem_req_mi") is None)
    ]

    latest_images_rows = [r for r in deployment_rows if r.get("image_flag") in ("latest", "untagged")]

    oom_rows = [r for r in deployment_rows if isinstance(r.get("reason_counts"), dict) and (r["reason_counts"].get("OOMKilled") or 0) > 0]

    failed_scheduling = any("FailedScheduling" in line for line in event_lines)
    readiness_failed = any("Readiness probe failed" in line or "ReadinessProbe" in line for line in event_lines)

    action_lines: List[str] = []
    action_lines.append("### High")

    # HA recommendation (nuanced)
    if node_count and node_count >= 2:
        user_facing_single = [r["name"] for r in deployment_rows if r.get("replicas") == 1 and is_probably_user_facing(r.get("name", ""))]
        controllers_single = [r["name"] for r in deployment_rows if r.get("replicas") == 1 and is_probably_control_plane(r.get("name", ""))]
        if user_facing_single:
            sample_names = ", ".join(f"`{n}`" for n in user_facing_single[:6]) + ("…" if len(user_facing_single) > 6 else "")
            action_lines.append(
                f"- **[High] 사용자 트래픽/게이트웨이 계열 HA 보강 (효과: 안정성)**  \n"
                f"  - 근거: node_count={node_count}인데 replicas=1. 사용자 facing으로 보이는 deployment {len(user_facing_single)}개 예: {sample_names}  \n"
                f"  - 권장: 우선 사용자 요청 경로(gateway/web/api/dashboard)부터 replicas=2+로 올리고, readiness/liveness를 확인  \n"
                f"  - 적용 예시: `spec.replicas: 2`"
            )
        if controllers_single:
            action_lines.append(
                f"- **[High] operator/controller는 replicas=1 유지 여부 검토 (효과: 안정성)**  \n"
                f"  - 근거: operator/controller로 보이는 deployment도 replicas=1 다수(예: `{controllers_single[0]}` 등)  \n"
                f"  - 권장: leader election 지원 여부 확인 후 2로 확장(지원 시) 또는 1 유지(의도된 싱글톤인 경우)"
            )

    # Missing resources
    if missing_resources_rows:
        examples = ", ".join(f"`{r['name']}`" for r in missing_resources_rows[:6]) + ("…" if len(missing_resources_rows) > 6 else "")
        action_lines.append(
            f"- **[High] requests/limits 누락 정리 (효과: 안정성/비용)**  \n"
            f"  - 근거: requests/limits 누락 의심 deployment {len(missing_resources_rows)}개 예: {examples}  \n"
            f"  - 권장: 최소한 `cpu/memory requests`를 먼저 채우고, 안정화 후 `limits` 적용"
        )

    # Hot memory targets with numbers + recommended values
    if hot_mem:
        action_lines.append("- **[High] Memory request 상향(스케줄링/eviction 리스크 감소) (효과: 안정성)**")
        for r in hot_mem[:6]:
            name = r["name"]
            req = r.get("mem_req_mi")
            lim = r.get("mem_lim_mi")
            usage = r.get("mem_usage_mi_avg")
            util = r.get("mem_util_pct")
            missing_req = int(r.get("missing_mem_req_containers") or 0)
            missing_lim = int(r.get("missing_mem_lim_containers") or 0)
            action_lines.append(
                f"  - 근거: `{name}` mem usage(pods avg snapshot)={fmt_mi(usage)} vs request={fmt_mi(req)} (util≈{util}%), limit={fmt_mi(lim)}"
            )
            if missing_req > 0:
                action_lines.append(
                    f"  - 주의: memory requests 누락 컨테이너가 있어(util 계산이 부정확할 수 있음) 먼저 컨테이너별 requests를 채운 뒤 재평가하세요. (missing={missing_req})"
                )
                continue
            if missing_lim > 0:
                action_lines.append(
                    f"  - 주의: memory limits 누락 컨테이너가 있어(limit 합계가 과소추정일 수 있음) 먼저 컨테이너별 limits를 확인/정리하세요. (missing={missing_lim})"
                )
                continue
            suspicious = (
                isinstance(lim, int)
                and isinstance(usage, int)
                and lim > 0
                and usage > int(lim * 1.1)
            )
            if suspicious:
                action_lines.append(
                    "  - 주의: **표상 usage(pods avg snapshot)가 limit보다 큼** → (1) 컨테이너별 limits 일부 누락 (2) 여러 컨테이너 합산/파싱 차이 가능. Pod 스펙으로 컨테이너별 resources를 먼저 확인하세요."
                )
                continue

            rec_req = rec_mem_request_mi(r)
            rec_lim = rec_limit_from_request(rec_req, 2.0, 128)
            if rec_req and rec_lim:
                action_lines.append(
                    f"  - 권장(초안): requests.memory≈`{fmt_mi(rec_req)}` (pods avg snapshot*1.5, round) / limits.memory≈`{fmt_mi(rec_lim)}` (request*2)  \n"
                    f"    - 적용 예시:\n"
                    f"      ```json\n"
                    f"      {{\n"
                    f"        \"resources\": {{\n"
                    f"          \"requests\": {{\"memory\": \"{rec_req}Mi\"}},\n"
                    f"          \"limits\": {{\"memory\": \"{rec_lim}Mi\"}}\n"
                    f"        }}\n"
                    f"      }}\n"
                    f"      ```"
                )

    # Hot CPU targets
    if hot_cpu:
        action_lines.append("- **[High] CPU request 상향 또는 HPA 검토 (효과: 안정성/성능)**")
        for r in hot_cpu[:4]:
            name = r["name"]
            req = r.get("cpu_req_m")
            lim = r.get("cpu_lim_m")
            usage = r.get("cpu_usage_m_avg")
            util = r.get("cpu_util_pct")
            missing_req = int(r.get("missing_cpu_req_containers") or 0)
            missing_lim = int(r.get("missing_cpu_lim_containers") or 0)
            action_lines.append(
                f"  - 근거: `{name}` cpu usage(pods avg snapshot)={fmt_m(usage)} vs request={fmt_m(req)} (util≈{util}%), limit={fmt_m(lim)}"
            )
            if missing_req > 0:
                action_lines.append(
                    f"  - 주의: cpu requests 누락 컨테이너가 있어(util 계산이 부정확할 수 있음) 먼저 컨테이너별 requests를 채운 뒤 재평가하세요. (missing={missing_req})"
                )
                continue
            if missing_lim > 0:
                action_lines.append(
                    f"  - 주의: cpu limits 누락 컨테이너가 있어(limit 합계가 과소추정일 수 있음) 먼저 컨테이너별 limits를 확인/정리하세요. (missing={missing_lim})"
                )
                continue
            suspicious = (
                isinstance(lim, int)
                and isinstance(usage, int)
                and lim > 0
                and usage > int(lim * 1.1)
            )
            if suspicious:
                action_lines.append(
                    "  - 주의: **표상 usage(pods avg snapshot)가 limit보다 큼** → (1) 컨테이너별 limits 일부 누락 (2) 여러 컨테이너 합산/파싱 차이 가능. Pod 스펙으로 컨테이너별 resources를 먼저 확인하세요."
                )
                continue

            rec_req = rec_cpu_request_m(r)
            rec_lim = rec_limit_from_request(rec_req, 2.0, 100)
            if rec_req and rec_lim:
                action_lines.append(
                    f"  - 권장(초안): requests.cpu≈`{fmt_m(rec_req)}` (pods avg snapshot*2, round) / limits.cpu≈`{fmt_m(rec_lim)}`  \n"
                    f"    - 적용 예시:\n"
                    f"      ```json\n"
                    f"      {{\n"
                    f"        \"resources\": {{\n"
                    f"          \"requests\": {{\"cpu\": \"{rec_req}m\"}},\n"
                    f"          \"limits\": {{\"cpu\": \"{rec_lim}m\"}}\n"
                    f"        }}\n"
                    f"      }}\n"
                    f"      ```"
                )

    # Scheduling / readiness event hints
    if failed_scheduling:
        action_lines.append(
            "- **[High] FailedScheduling(affinity/nodeSelector) 원인 확인 (효과: 안정성)**  \n"
            "  - 근거: Warning events에 `FailedScheduling` 존재 (node affinity/selector 불일치)  \n"
            "  - 권장: 해당 Pod의 `nodeSelector/affinity/tolerations`와 노드 label/taint를 비교해서 스케줄 가능하도록 조정"
        )
    if readiness_failed:
        action_lines.append(
            "- **[High] Readiness probe 실패 원인 점검 (효과: 안정성/가용성)**  \n"
            "  - 근거: Warning events에 `Readiness probe failed` 존재  \n"
            "  - 권장: probe endpoint/timeout/initialDelaySeconds 확인 + 앱 로그/헬스체크 응답 시간 측정"
        )

    action_lines.append("")
    action_lines.append("### Medium")

    if latest_images_rows:
        examples = ", ".join(f"`{r['name']}`" for r in latest_images_rows[:6]) + ("…" if len(latest_images_rows) > 6 else "")
        action_lines.append(
            f"- **[Medium] 이미지 태그 pinning (효과: 안정성/재현성)**  \n"
            f"  - 근거: latest/미태깅 이미지 가능성 {len(latest_images_rows)}개 예: {examples}  \n"
            f"  - 권장: `:latest` 대신 버전 태그 또는 digest 사용"
        )

    if oom_rows:
        examples = ", ".join(f"`{r['name']}`" for r in oom_rows[:6]) + ("…" if len(oom_rows) > 6 else "")
        action_lines.append(
            f"- **[Medium] OOMKilled 원인 분석 및 memory limit/request 재조정 (효과: 안정성)**  \n"
            f"  - 근거: OOMKilled 감지 deployment {len(oom_rows)}개 예: {examples}  \n"
            f"  - 권장: (1) OOMKilled 시점 로그/메트릭 확인 (2) memory limit이 실제 피크를 수용하는지 확인 (3) 누수/캐시 설정 점검"
        )

    if over_cpu:
        action_lines.append("- **[Medium] CPU request 과대(낭비) 의심 - 하향 검토 (효과: 비용)**")
        for r in over_cpu[:4]:
            name = r["name"]
            req = r.get("cpu_req_m")
            usage = r.get("cpu_usage_m_avg")
            util = r.get("cpu_util_pct")
            if not isinstance(req, int):
                continue
            suggested = round_up_int(max(int((usage or 0) * 2), 50), 10) if isinstance(usage, int) else max(int(req * 0.5), 50)
            action_lines.append(
                f"  - 근거: `{name}` cpu usage(pods avg snapshot)={fmt_m(usage)} vs request={fmt_m(req)} (util≈{util}%)  \n"
                f"  - 권장(초안): requests.cpu≈`{fmt_m(suggested)}`로 낮추고 모니터링(p95 기반으로 재조정)"
            )

    action_plan_md = "\n".join(action_lines).strip()

    # Text-only version (for LLM; keep same content but without heavy markdown table constraints)
    text = {
        "namespace": namespace,
        "overview": overview,
        "deployments_count": len(deployments),
        "pods_count": len(pods),
        "deployment_rows": deployment_rows,
        "warning_events_sample": event_lines,
        "auto_findings": findings[:40],
        "pod_metrics_available": pod_metrics is not None,
        "action_plan_md": action_plan_md,
    }

    return {
        "observations_md": md,
        "observations_text": json.dumps(text, ensure_ascii=False),
        "action_plan_md": action_plan_md,
    }
