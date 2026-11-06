"""The AI chat's k8s_get_resources table says what kubectl prints and what the Pods and Services lists show. The cases
come from k8s-service's TestAITableCasesFixture (UPDATE_AI_TABLE_CASES=1 rewrites them): objects as kubectl lists them,
with the lists' READY, STATUS, RESTARTS and EXTERNAL-IP. This draws the table over the same objects."""
import json
from pathlib import Path

from app.services.ai.formatters import _format_k8s_get_resources_display

CASES = json.loads((Path(__file__).parent / "fixtures" / "kubectl_table_cases.json").read_text())


def table(resource_type: str, *objects: dict) -> list[dict]:
    """The table as rows of {column: cell}, cut at the header's columns: an empty cell stays empty."""
    lines = _format_k8s_get_resources_display(resource_type, "wide", json.dumps({"items": list(objects)})).split("\n")
    head = lines[0]
    names = head.split()
    starts = [head.index(n) for n in names]
    ends = starts[1:] + [None]
    return [{n: line[s:e].strip() for n, s, e in zip(names, starts, ends)} for line in lines[1:]]


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
