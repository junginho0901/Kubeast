"""The AI chat's k8s_get_resources table says what kubectl prints and what the lists show. The cases come from
k8s-service's TestAITableCasesFixture (UPDATE_AI_TABLE_CASES=1 rewrites them): objects as kubectl lists them, with what
the lists and kubectl's printers write for them, and tool-server's TestPodsListAnswerCases (UPDATE_POD_ANSWER_CASES=1):
its answer for more pods than it lists. This draws the table over the same objects."""
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.services.ai.formatters import _build_tool_display, _format_age, _format_k8s_get_resources_display, _format_tool_result, _human_duration

FIXTURES = Path(__file__).parent / "fixtures"
CASES = json.loads((FIXTURES / "kubectl_table_cases.json").read_text())
POD_ANSWERS = json.loads((FIXTURES / "pods_list_answers.json").read_text())


def rows_of(lines: list[str]) -> list[dict]:
    """The table as rows of {column: cell}, cut at the header's columns: an empty cell stays empty."""
    head = lines[0]
    names = head.split()
    starts = [m.start() for m in re.finditer(r"\S+", head)]
    ends = starts[1:] + [None]
    return [{n: line[s:e].strip() for n, s, e in zip(names, starts, ends)} for line in lines[1:]]


def table(resource_type: str, *objects: dict) -> list[dict]:
    return rows_of(_format_k8s_get_resources_display(resource_type, "wide", json.dumps({"items": list(objects)})).split("\n"))


def pods_display(case: dict) -> str | None:
    text, is_json, is_yaml = _format_tool_result("k8s_get_resources", case["args"], case["answer"])
    return _build_tool_display("k8s_get_resources", case["args"], text, is_json, is_yaml)


def pod_answer(name: str) -> dict:
    return next(c for c in POD_ANSWERS if c["name"] == name)


def display_rows(display: str) -> list[dict]:
    """The rows under the lines that say what the answer covers: the table starts after the blank line."""
    return rows_of(display.split("\n\n", 1)[1].split("\n"))


def test_an_answer_for_many_pods_draws_the_rows_it_holds_and_no_other():
    assert len(POD_ANSWERS) >= 3
    for case in POD_ANSWERS:
        display = pods_display(case)
        assert display is not None, case["name"]
        assert "Unknown" not in display, case["name"]
        if not case["rows"]:
            continue
        rows = display_rows(display)
        columns = rows[0].keys()
        assert rows == [{k: want[k] for k in columns} for want in case["rows"]], case["name"]


def test_an_answer_for_many_pods_says_how_many_there_are_and_which_it_shows():
    display = pods_display(pod_answer("the first page of every namespace"))
    assert display.split("\n")[0] == "312 pods in all namespaces. Showing 4 from offset 0, errors and warnings first. Next page: offset 4."


def test_an_answer_for_many_pods_shows_its_counts_before_the_rows():
    display = pods_display(pod_answer("the first page of every namespace"))
    head = display.split("\n\n", 1)[0].split("\n")
    assert head[1:] == [
        "Need attention: 20 (ok 292, warn 13, error 7)",
        "Phases: Running 300, Pending 12",
        "Top statuses: Running 290, CrashLoopBackOff 7",
        "Namespaces: shop 40, (other) 272",
        "Nodes: n1 50, (other) 262",
    ]


def test_the_last_page_of_an_answer_names_no_next_page():
    display = pods_display(pod_answer("the last page of one namespace"))
    assert display.split("\n")[0] == "27 pods in shop. Showing 2 from offset 25, errors and warnings first."


def test_a_page_of_one_namespace_leaves_the_namespace_column_out_as_the_other_tables_do():
    head = next(line for line in pods_display(pod_answer("the last page of one namespace")).split("\n") if line.startswith("NAME"))
    assert head.split() == ["NAME", "READY", "STATUS", "RESTARTS", "NODE"]


def test_an_offset_past_the_end_says_so_and_does_not_read_as_no_pods():
    display = pods_display(pod_answer("an offset past the end"))
    assert display.split("\n")[0] == "312 pods in all namespaces. Showing 0 from offset 400, errors and warnings first."
    assert "No resources found" not in display


def test_a_pods_answer_whose_rows_cannot_be_read_stays_as_it_came():
    answer = json.dumps({"resource_type": "pods", "total": 30, "pods": ["not the row format"]})
    assert _format_k8s_get_resources_display("pods", "wide", answer) is None


@pytest.mark.parametrize("answer", [
    {"status": "too_large", "resource_type": "pods", "scope": "shop", "reason": "the list is larger", "hint": "narrow it"},
    {"status": "not_found", "resource_type": "pods", "name": "web-1"},
    {"status": "forbidden", "reason": "not allowed"},
    {"resource_type": "pods", "total": 30},
    ["web-1", "web-2"],
])
def test_an_answer_that_holds_no_objects_is_not_drawn_as_a_row(answer):
    for kind in ("pods", "deployments", "services", "namespaces", "nodes", "configmaps"):
        assert _format_k8s_get_resources_display(kind, "wide", json.dumps(answer)) is None


@pytest.mark.parametrize("value", ["3", "true", '"web-1"'])
def test_a_single_value_a_jsonpath_printed_does_not_read_as_no_resources(value):
    assert _format_k8s_get_resources_display("deployments", "jsonpath={.spec.replicas}", value) is None


def test_a_single_object_is_still_a_row():
    single = {"metadata": {"name": "web-1"}, "spec": {"containers": [{"name": "c"}]}, "status": {"phase": "Running"}}
    assert rows_of(_format_k8s_get_resources_display("pods", "json", json.dumps(single)).split("\n"))[0]["NAME"] == "web-1"


def test_an_empty_list_reads_no_resources():
    assert _format_k8s_get_resources_display("pods", "json", json.dumps({"kind": "PodList", "metadata": {}, "items": []})) == "No resources found."
    assert _format_k8s_get_resources_display("pods", "json", json.dumps({"kind": "PodList", "metadata": {}, "items": None})) == "No resources found."


def test_a_node_row_is_what_kubectl_prints_for_every_case():
    assert len(CASES["nodes"]) >= 80
    rows = {r["NAME"]: r for r in table("nodes", *[c["node"] for c in CASES["nodes"]])}
    wrong = []
    for c in CASES["nodes"]:
        name = c["node"]["metadata"]["name"]
        got = {"STATUS": rows[name]["STATUS"], "ROLES": rows[name]["ROLES"], "VERSION": rows[name]["VERSION"]}
        want = {"STATUS": c["status"], "ROLES": c["roles"], "VERSION": "v1.37.2"}
        if got != want:
            wrong.append((name, got, want))
    assert wrong == []


def test_a_cordoned_node_reads_scheduling_disabled():
    node = {"metadata": {"name": "n1"}, "spec": {"unschedulable": True}, "status": {"conditions": [{"type": "Ready", "status": "True"}]}}
    assert table("nodes", node)[0]["STATUS"] == "Ready,SchedulingDisabled"


def test_a_node_with_no_ready_condition_reads_unknown():
    assert table("nodes", {"metadata": {"name": "n1"}, "status": {"conditions": []}})[0]["STATUS"] == "Unknown"


def test_a_service_row_has_kubectls_cluster_ip_and_ports_for_every_case():
    rows = {r["NAME"]: r for r in table("services", *[c["service"] for c in CASES["services"]])}
    wrong = []
    for c in CASES["services"]:
        name = c["service"]["metadata"]["name"]
        got = {"CLUSTER-IP": rows[name]["CLUSTER-IP"], "PORT(S)": rows[name]["PORT(S)"]}
        want = {"CLUSTER-IP": c["cluster_ip"], "PORT(S)": c["ports"]}
        if got != want:
            wrong.append((name, got, want))
    assert wrong == []


def test_an_external_name_service_reads_none_for_its_address_and_ports():
    row = table("services", {"metadata": {"name": "db"}, "spec": {"type": "ExternalName", "externalName": "db.example.test"}})[0]
    assert (row["CLUSTER-IP"], row["EXTERNAL-IP"], row["PORT(S)"]) == ("<none>", "db.example.test", "<none>")


def test_a_dual_stack_service_reads_its_first_address():
    row = table("services", {"metadata": {"name": "web"}, "spec": {"type": "ClusterIP", "clusterIP": "fd00::1", "clusterIPs": ["fd00::1", "10.0.0.2"], "ports": [{"port": 80, "protocol": "TCP"}]}})[0]
    assert row["CLUSTER-IP"] == "fd00::1"


def test_an_age_is_apimachinerys_for_every_case():
    assert len(CASES["ages"]) >= 60
    wrong = [(c["seconds"], _human_duration(c["seconds"]), c["age"]) for c in CASES["ages"] if _human_duration(c["seconds"]) != c["age"]]
    assert wrong == []


NOW = datetime(2026, 11, 7, 12, 0, 0, tzinfo=timezone.utc)


def ago(**since: int) -> str:
    return (NOW - timedelta(**since)).strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.mark.parametrize("since,want", [
    ({"seconds": 90}, "90s"),
    ({"minutes": 5, "seconds": 10}, "5m10s"),
    ({"minutes": 70}, "70m"),
    ({"hours": 5}, "5h"),
    ({"hours": 5, "minutes": 30}, "5h30m"),
    ({"hours": 49}, "2d1h"),
    ({"days": 367}, "367d"),
    ({"days": 731}, "2y1d"),
])
def test_an_age_reads_as_kubectl_prints_it_from_a_timestamp(since, want):
    assert _format_age(ago(**since), now=NOW) == want


@pytest.mark.parametrize("timestamp", [None, "", "not a time", "0001-01-01T00:00:00Z", "1970-01-01T00:00:00Z"])
def test_no_time_reads_as_a_dash_as_on_the_screen(timestamp):
    assert _format_age(timestamp, now=NOW) == "-"


def test_a_time_ahead_of_the_clock_reads_as_kubectl_prints_it():
    assert _format_age((NOW + timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ"), now=NOW) == "0s"
    assert _format_age((NOW + timedelta(seconds=5)).strftime("%Y-%m-%dT%H:%M:%SZ"), now=NOW) == "<invalid>"


def test_a_pod_row_is_what_the_pods_list_shows_for_every_case():
    assert len(CASES["pods"]) >= 400
    rows = {r["NAME"]: r for r in table("pods", *[c["pod"] for c in CASES["pods"]])}
    wrong = []
    for c in CASES["pods"]:
        name = c["pod"]["metadata"]["name"]
        want = {"READY": c["ready"], "STATUS": c["status"], "RESTARTS": str(c["restarts"])}
        got = {k: rows[name][k] for k in want}
        if got != want:
            wrong.append((name, got, want))
    assert wrong == []


def test_a_service_row_is_what_the_services_list_shows_for_every_case():
    assert len(CASES["services"]) >= 200
    rows = {r["NAME"]: r for r in table("services", *[c["service"] for c in CASES["services"]])}
    wrong = [
        (c["service"]["metadata"]["name"], rows[c["service"]["metadata"]["name"]]["EXTERNAL-IP"], c["external_ip"])
        for c in CASES["services"]
        if rows[c["service"]["metadata"]["name"]]["EXTERNAL-IP"] != c["external_ip"]
    ]
    assert wrong == []


def pod(name: str, phase: str = "Running", init: list | None = None, init_statuses: list | None = None, statuses: list | None = None,
        containers: int = 1, **status: object) -> dict:
    return {
        "metadata": {"name": name},
        "spec": {"containers": [{"name": f"c{i}"} for i in range(containers)], "initContainers": init or []},
        "status": {"phase": phase, "initContainerStatuses": init_statuses or [], "containerStatuses": statuses or [], **status},
    }


SIDECAR = {"name": "side", "restartPolicy": "Always"}
RUNNING = {"running": {}}
INITIALIZED = [{"type": "Initialized", "status": "True"}, {"type": "Ready", "status": "True"}]


def test_a_pod_with_a_sidecar_counts_it_in_ready_and_restarts():
    row = table("pods", pod(
        "with-sidecar", init=[SIDECAR],
        init_statuses=[{"name": "side", "ready": True, "started": True, "restartCount": 2, "state": RUNNING}],
        statuses=[{"name": "c0", "ready": True, "restartCount": 1, "state": RUNNING}],
        conditions=INITIALIZED,
    ))[0]
    assert (row["READY"], row["STATUS"], row["RESTARTS"]) == ("2/2", "Running", "3")


def test_a_sidecar_up_but_not_ready_shows_one_of_two():
    row = table("pods", pod(
        "side-not-ready", init=[SIDECAR],
        init_statuses=[{"name": "side", "ready": False, "started": True, "state": RUNNING}],
        statuses=[{"name": "c0", "ready": True, "state": RUNNING}],
        conditions=INITIALIZED,
    ))[0]
    assert row["READY"] == "1/2"


def test_a_pod_still_initializing_reads_as_kubectl_prints_it():
    row = table("pods", pod(
        "starting", phase="Pending", init=[{"name": "migrate"}],
        init_statuses=[{"name": "migrate", "restartCount": 4, "state": {"waiting": {"reason": "CrashLoopBackOff"}}}],
        statuses=[{"name": "c0", "ready": False, "restartCount": 9, "state": {"waiting": {"reason": "PodInitializing"}}}],
    ))[0]
    assert (row["READY"], row["STATUS"], row["RESTARTS"]) == ("0/1", "Init:CrashLoopBackOff", "4")


def test_a_pod_being_deleted_reads_terminating():
    deleted = pod("leaving", statuses=[{"name": "c0", "ready": True, "state": RUNNING}])
    deleted["metadata"]["deletionTimestamp"] = "2026-11-07T00:00:00Z"
    row = table("pods", deleted)[0]
    assert (row["READY"], row["STATUS"]) == ("1/1", "Terminating")


def test_a_finished_pod_whose_sidecar_ended_on_sigterm_reads_completed():
    row = table("pods", pod(
        "finished", phase="Succeeded", init=[SIDECAR],
        init_statuses=[{"name": "side", "started": False, "state": {"terminated": {"reason": "Error", "exitCode": 143}}}],
        statuses=[{"name": "c0", "state": {"terminated": {"reason": "Completed", "exitCode": 0}}}],
        conditions=[{"type": "Initialized", "status": "True"}],
    ))[0]
    assert (row["READY"], row["STATUS"]) == ("0/2", "Completed")


def service(name: str, kind: str, external_ips: list | None = None, ingress: list | None = None, external_name: str | None = None) -> dict:
    spec: dict = {"type": kind, "clusterIP": "10.0.0.1", "ports": [{"port": 80, "protocol": "TCP"}]}
    if external_ips:
        spec["externalIPs"] = external_ips
    if external_name:
        spec["externalName"] = external_name
    return {"metadata": {"name": name}, "spec": spec, "status": {"loadBalancer": {"ingress": ingress} if ingress else {}}}


def test_external_ip_reads_as_kubectl_prints_it():
    rows = table(
        "services",
        service("cluster", "ClusterIP"),
        service("cluster-with-address", "ClusterIP", external_ips=["192.0.2.9", "192.0.2.1"]),
        service("cluster-with-lb-status", "ClusterIP", ingress=[{"ip": "192.0.2.1"}]),
        service("node-port", "NodePort"),
        service("external-name", "ExternalName", external_name="db.example.test"),
        service("lb-pending", "LoadBalancer"),
        service("lb-ip-and-host", "LoadBalancer", ingress=[{"ip": "192.0.2.1", "hostname": "lb.example.test"}]),
        service("lb-sorted-once", "LoadBalancer", ingress=[{"ip": "192.0.2.9"}, {"hostname": "lb.example.test"}, {"ip": "192.0.2.1"}, {"ip": "192.0.2.9"}]),
        service("lb-and-external", "LoadBalancer", external_ips=["192.0.2.9"], ingress=[{"ip": "192.0.2.1"}, {"hostname": "lb.example.test"}]),
        service("lb-no-address-external", "LoadBalancer", external_ips=["192.0.2.9"]),
    )
    assert {r["NAME"]: r["EXTERNAL-IP"] for r in rows} == {
        "cluster": "<none>",
        "cluster-with-address": "192.0.2.9,192.0.2.1",
        "cluster-with-lb-status": "<none>",
        "node-port": "<none>",
        "external-name": "db.example.test",
        "lb-pending": "<pending>",
        "lb-ip-and-host": "192.0.2.1",
        "lb-sorted-once": "192.0.2.1,192.0.2.9,lb.example.test",
        "lb-and-external": "192.0.2.1,lb.example.test,192.0.2.9",
        "lb-no-address-external": "192.0.2.9",
    }


def test_a_container_with_no_status_yet_counts_in_the_total():
    row = table("pods", pod("partly", statuses=[{"name": "c0", "ready": True, "state": RUNNING}], containers=2))[0]
    assert row["READY"] == "1/2"


def test_the_table_still_reads_what_it_read_before():
    assert table("services", service("web", "ClusterIP"))[0]["PORT(S)"] == "80/TCP"
    assert table("services", service("web", "ClusterIP"))[0]["CLUSTER-IP"] == "10.0.0.1"
    row = table("pods", pod("plain", statuses=[{"name": "c0", "ready": True, "restartCount": 3, "state": RUNNING}]))[0]
    assert (row["READY"], row["STATUS"], row["RESTARTS"]) == ("1/1", "Running", "3")
