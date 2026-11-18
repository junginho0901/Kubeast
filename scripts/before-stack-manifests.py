#!/usr/bin/env python3
# The manifests of scripts/before-stack.sh, read from what the dev install runs now: each service again as
# <name>-before (Service first, so hostAliases can name its address), and the two network policies its pods need.
# A container given the tag's image takes that tag's chart's probes, since a build answers the paths of its own code
# (0.7.8 probes /readyz and /livez, which 0.7.7 does not serve); a probe left that the tag's chart does not give that
# container stops the script before the Deployments are applied.
# Prints a kubectl List. --check reads this checkout's chart with deploy/kind/values.yaml in place of the cluster,
# prints each container's probes and applies nothing. Python 3.9+, stdlib only; git and helm read the tag's chart.
import copy
import json
import os
import subprocess
import sys
import tempfile

CHECK = sys.argv[1:] == ["--check"]
NS = os.environ["KC_NS"]
CONTEXT = os.environ["KC_CONTEXT"]
TAG = os.environ["BEFORE_TAG"]
REGISTRY = os.environ["BEFORE_REGISTRY"]
REDIS_DB = os.environ["BEFORE_REDIS_DB"]
LABEL = os.environ["BEFORE_LABEL"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The gateway runs the stock nginx image: only its upstreams change, through hostAliases.
CALLED = ["auth-service", "k8s-service", "session-service", "ai-service", "frontend"]
STACK = CALLED + ["gateway"]
# Pods of the old build reach these of the dev install: the data, and the AI tools (same tool server for both builds).
SHARED = ["postgres", "redis", "tool-server"]
PROBES = ("startupProbe", "readinessProbe", "livenessProbe")
# A chart that prints each Deployment helm rendered as a line of JSON, as scripts/values-paths.sh reads values.
TO_JSON = r"""{{- range regexSplit "(?m)^---\\s*$" .Values.rendered -1 }}
{{- $d := fromYaml . }}
{{- if eq (toString $d.kind) "Deployment" }}
# {{ toJson $d }}
{{- end }}
{{- end }}
"""


def kubectl(*args, stdin=None):
    out = subprocess.run(
        ["kubectl", "--context", CONTEXT, "-n", NS, *args],
        input=stdin, capture_output=True, text=True, check=True,
    )
    return out.stdout


def run(*args, stdin=None):
    out = subprocess.run(args, input=stdin, capture_output=True)
    if out.returncode:
        sys.exit(f"before-stack: {' '.join(args[:2])} failed: {out.stderr.decode(errors='replace').strip()}")
    return out.stdout


def rendered(chart, *flags):
    """The Deployments helm renders of a chart, by name."""
    # existing Secrets leave out the signing key secret.yaml makes, 4 s of a render (scripts/chart-upgrade-values.sh)
    flags += ("--set", "secrets.existingSecret=kubeast-secrets",
              "--set", "auth.signingKey.existingSecret=kubeast-auth-keys")
    with tempfile.TemporaryDirectory() as tmp:
        manifests = os.path.join(tmp, "manifests.yaml")
        with open(manifests, "wb") as f:
            f.write(run("helm", "template", "kubeast", chart, "--namespace", NS, *flags))
        os.makedirs(os.path.join(tmp, "to-json", "templates"))
        with open(os.path.join(tmp, "to-json", "Chart.yaml"), "w") as f:
            f.write("apiVersion: v2\nname: to-json\nversion: 0.0.0\n")
        with open(os.path.join(tmp, "to-json", "templates", "deployments.yaml"), "w") as f:
            f.write(TO_JSON)
        out = run("helm", "template", "to-json", os.path.join(tmp, "to-json"), "--set-file", f"rendered={manifests}")
    found = [json.loads(line[2:]) for line in out.decode().splitlines() if line.startswith("# {")]
    return {d["metadata"]["name"]: d for d in found}


def tag_containers():
    """The containers of the tag's chart on its own defaults (its probes read no value), by Deployment and name."""
    with tempfile.TemporaryDirectory() as tmp:
        archive = subprocess.run(["git", "-C", ROOT, "archive", TAG, "helm/kubeast"], capture_output=True)
        if archive.returncode:
            sys.exit(f"before-stack: no chart of {TAG} here ({archive.stderr.decode(errors='replace').strip()}); "
                     f"git fetch origin tag {TAG}")
        run("tar", "-x", "-C", tmp, stdin=archive.stdout)
        deployments = rendered(os.path.join(tmp, "helm", "kubeast"))
    return {n: {c["name"]: c for c in d["spec"]["template"]["spec"]["containers"]} for n, d in deployments.items()}


def asks(probe):
    """What a probe asks the container: a path and port, or its other handler."""
    if not probe:
        return None
    get = probe.get("httpGet")
    if get:
        return f"{get.get('path')}:{get.get('port')}"
    return json.dumps({k: v for k, v in probe.items() if k in ("exec", "tcpSocket", "grpc")}, sort_keys=True)


def shown(container):
    return " · ".join(f"{k} {asks(container[k])}" for k in PROBES if container.get(k)) or "no probe"


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


def keeps_image(name):
    return name == "gateway" or TAG == "local"


def image_of(name, current):
    if keeps_image(name):
        return current
    return f"{REGISTRY}{name}:{TAG}"


def unserved(name, container):
    """The probes of a container on the tag's image that the tag's chart does not give it."""
    if keeps_image(name):
        return []
    own = OWN.get(name, {}).get(container["name"], {})
    known = {asks(own.get(k)) for k in PROBES}
    return [f"{k} {asks(container[k])}" for k in PROBES if container.get(k) and asks(container[k]) not in known]


def deployment(name, aliases, live):
    template = live["spec"]["template"]
    pod = template["spec"]
    pod["hostAliases"] = aliases
    for key in ("affinity", "topologySpreadConstraints"):
        pod.pop(key, None)
    container = pod["containers"][0]
    container["image"] = image_of(name, container["image"])
    if TAG != "local":
        container["imagePullPolicy"] = "IfNotPresent"
    if not keeps_image(name):
        own = OWN.get(name, {}).get(container["name"])
        if own is None:
            sys.exit(f"before-stack: the {TAG} chart has no container {container['name']} in a Deployment {name}")
        for key in PROBES:
            container.pop(key, None)
            if own.get(key):
                container[key] = own[key]
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


def stop_on_unserved(built):
    bad = [f"{d['metadata']['name']} {p}" for n, d in built
           for p in unserved(n, d["spec"]["template"]["spec"]["containers"][0])]
    if bad:
        sys.exit(f"before-stack: probes the {TAG} chart does not give these containers: {', '.join(bad)}")


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


OWN = {} if TAG == "local" else tag_containers()
if CHECK:
    here = rendered(os.path.join(ROOT, "helm", "kubeast"), "-f", os.path.join(ROOT, "deploy", "kind", "values.yaml"))
    built = []
    for n in STACK:
        was = copy.deepcopy(here[n]["spec"]["template"]["spec"]["containers"][0])
        d = deployment(n, [], here[n])
        built.append((n, d))
        line = f"{d['metadata']['name']}: {shown(d['spec']['template']['spec']['containers'][0])}"
        if keeps_image(n):
            line += " (this checkout's image and probes)"
        elif unserved(n, was):
            line += f" · this checkout's not in the {TAG} chart: {', '.join(unserved(n, was))}"
        print(line)
    stop_on_unserved(built)
    sys.exit(0)
services = [service(n) for n in STACK]
kubectl("apply", "-f", "-", stdin=json.dumps({"apiVersion": "v1", "kind": "List", "items": services}))
aliases = [{"ip": address(n), "hostnames": [n]} for n in CALLED]
built = [(n, deployment(n, aliases, json.loads(kubectl("get", "deployment", n, "-o", "json")))) for n in STACK]
stop_on_unserved(built)
items = services + policies() + [d for _, d in built]
print(json.dumps({"apiVersion": "v1", "kind": "List", "items": items}))
