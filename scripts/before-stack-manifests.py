#!/usr/bin/env python3
# The manifests of scripts/before-stack.sh, read from what the dev install runs now: each service again as
# <name>-before (Service first, so hostAliases can name its address), and the two network policies its pods need.
# Prints a kubectl List. Python 3.9+, stdlib only.
import json
import os
import subprocess

NS = os.environ["KC_NS"]
CONTEXT = os.environ["KC_CONTEXT"]
TAG = os.environ["BEFORE_TAG"]
REGISTRY = os.environ["BEFORE_REGISTRY"]
REDIS_DB = os.environ["BEFORE_REDIS_DB"]
LABEL = os.environ["BEFORE_LABEL"]

# The gateway runs the stock nginx image: only its upstreams change, through hostAliases.
CALLED = ["auth-service", "k8s-service", "session-service", "ai-service", "frontend"]
STACK = CALLED + ["gateway"]
# Pods of the old build reach these of the dev install: the data, and the AI tools (same tool server for both builds).
SHARED = ["postgres", "redis", "tool-server"]


def kubectl(*args, stdin=None):
    out = subprocess.run(
        ["kubectl", "--context", CONTEXT, "-n", NS, *args],
        input=stdin, capture_output=True, text=True, check=True,
    )
    return out.stdout


def labels(name):
    return {"app": f"{name}-before", LABEL: "true"}


def service(name):
    live = json.loads(kubectl("get", "service", name, "-o", "json"))
    ports = [{k: p[k] for k in ("name", "port", "protocol", "targetPort") if k in p} for p in live["spec"]["ports"]]
    return {
        "apiVersion": "v1", "kind": "Service",
        "metadata": {"name": f"{name}-before", "namespace": NS, "labels": labels(name)},
        "spec": {"type": "ClusterIP", "selector": {"app": f"{name}-before"}, "ports": ports},
    }


def address(name):
    return json.loads(kubectl("get", "service", f"{name}-before", "-o", "json"))["spec"]["clusterIP"]


def image_of(name, current):
    if name == "gateway" or TAG == "local":
        return current
    return f"{REGISTRY}{name}:{TAG}"


def deployment(name, aliases):
    live = json.loads(kubectl("get", "deployment", name, "-o", "json"))
    template = live["spec"]["template"]
    pod = template["spec"]
    pod["hostAliases"] = aliases
    for key in ("affinity", "topologySpreadConstraints"):
        pod.pop(key, None)
    container = pod["containers"][0]
    container["image"] = image_of(name, container["image"])
    if TAG != "local":
        container["imagePullPolicy"] = "IfNotPresent"
    if container.get("envFrom"):
        env = [e for e in container.get("env", []) if e["name"] not in ("REDIS_DB", "MIGRATIONS_MODE")]
        container["env"] = env + [
            {"name": "REDIS_DB", "value": REDIS_DB},
            {"name": "MIGRATIONS_MODE", "value": "job"},
        ]
    template["metadata"] = {"labels": labels(name), "annotations": template["metadata"].get("annotations", {})}
    return {
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": f"{name}-before", "namespace": NS, "labels": labels(name)},
        "spec": {"replicas": 1, "selector": {"matchLabels": {"app": f"{name}-before"}}, "template": template},
    }


def policies():
    before = {"matchLabels": {LABEL: "true"}}
    return [
        {
            "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
            "metadata": {"name": "before-stack-open", "namespace": NS, "labels": {LABEL: "true"}},
            "spec": {"podSelector": before, "policyTypes": ["Ingress", "Egress"], "ingress": [{}], "egress": [{}]},
        },
        {
            "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
            "metadata": {"name": "before-stack-shared", "namespace": NS, "labels": {LABEL: "true"}},
            "spec": {
                "podSelector": {"matchExpressions": [{"key": "app", "operator": "In", "values": SHARED}]},
                "policyTypes": ["Ingress"],
                "ingress": [{"from": [{"podSelector": before}]}],
            },
        },
    ]


services = [service(n) for n in STACK]
kubectl("apply", "-f", "-", stdin=json.dumps({"apiVersion": "v1", "kind": "List", "items": services}))
aliases = [{"ip": address(n), "hostnames": [n]} for n in CALLED]
items = services + policies() + [deployment(n, aliases) for n in STACK]
print(json.dumps({"apiVersion": "v1", "kind": "List", "items": items}))
