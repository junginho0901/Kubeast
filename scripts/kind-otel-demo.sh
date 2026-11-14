#!/usr/bin/env bash
# The OpenTelemetry Demo (Astronomy Shop) on kind for the AI evaluation's service cases (scripts/ai-eval.py): a dozen
# services that call each other, a load generator and the demo's failure flags (flagd), in namespace otel-demo of the
# second cluster (kubeast-b, Kubeast id "default"). The pinned chart is rendered with deploy/kind/otel-demo-values.yaml
# and applied server-side, so that cluster keeps no Helm release. The demo's own Jaeger, Grafana, Prometheus and
# OpenSearch are off: its collector writes traces to the Tempo of scripts/kind-tracing.sh, logs to the Loki of
# scripts/kind-logsearch.sh and metrics to the cluster's Prometheus by remote write (deploy/kind/second-cluster.yaml).
# Run those up first.
#
#   scripts/kind-otel-demo.sh up                     # again to apply a change; the memory check is for the first up
#   OTELDEMO_METRICS=0 scripts/kind-otel-demo.sh up  # metrics and alert rules kept out of that Prometheus (384 Mi, 2 h)
#   scripts/kind-otel-demo.sh down                   # what up made; the stores keep what the demo sent
#
# Alert rules: with metrics on, up puts deploy/kind/otel-demo-rules.json (error rate and 95th percentile latency of each
# service's server spans, container restarts in otel-demo) into the Prometheus ConfigMap as extra-rules-otel-demo.json,
# which its rule_files read, and sends Prometheus SIGHUP once the kubelet has updated the mounted file; down takes it
# out the same way. The alerts carry kubeast_eval="otel-demo", the one label that Prometheus sends to Alertmanager
# (deploy/kind/second-cluster.yaml), whose default route posts them to Kubeast's webhook for cluster "default", where
# the investigator takes severity warning. The e2e specs pick alerts by kubeast_e2e, e2e_run or names of their own and
# find none of these. flagd is left out of both span rules: its event stream is one long call. The thresholds (5 %,
# 1000 ms) are not measured on kind yet.
#
# Memory: the first up refuses when the Docker VM has less memory available than the demo's containers may take —
# MemAvailable of /proc/meminfo read in the kind node (it shares the VM's kernel) against the sum of the memory limits
# in the render (about 6.7 GiB with the pinned chart; the demo's Kubernetes page asks 6 GB free for the full demo with
# its own backends). The lighter fallback when it does not fit is Google's Online Boutique
# (GoogleCloudPlatform/microservices-demo v0.10.7, Apache-2.0): 12 Deployments whose memory limits add up to 2542 Mi in
# release/kubernetes-manifests.yaml. It sends no traces unless its google-cloud-operations kustomize component adds a
# collector, which writes to Google Cloud and would have to be pointed at the Tempo. There is no script for it.
#
# Behind a TLS-inspecting proxy the node must trust it before it pulls the images: set OTELDEMO_NODE_HOOK to a command
# that gets the cluster name (run before the images). A node that cannot pull an image gets it from the host's docker.
# The render holds the chart's demo credentials (database, flagd-ui): it stays in a temporary file and is not printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${OTELDEMO_CLUSTER:-kubeast-b}"
NODE="$STORE-control-plane"
NS="otel-demo"
OTELDEMO_CHART_VERSION="0.42.6"
VALUES="$ROOT/deploy/kind/otel-demo-values.yaml"
RULES="$ROOT/deploy/kind/otel-demo-rules.json"
RULES_KEY="extra-rules-otel-demo.json"  # matches rule_files' /etc/prometheus/extra-rules-* in deploy/kind/second-cluster.yaml

case "${1:-}" in
  up|down) ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac

KC="$(mktemp)"
MANIFEST="$(mktemp)"
trap 'rm -f "$KC" "$MANIFEST"' EXIT
kind get kubeconfig --name "$STORE" > "$KC" 2>/dev/null \
  || { echo "no kind cluster $STORE (OTELDEMO_CLUSTER names another)" >&2; exit 1; }
k() { kubectl --kubeconfig "$KC" "$@"; }

# import_image <reference> — the node pulls it; where it cannot (a proxy), it comes from the host's docker.
import_image() {
  docker exec "$NODE" crictl pull "$1" >/dev/null 2>&1 && return
  docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null
  docker save "$1" | docker exec --privileged -i "$NODE" \
    ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
}

render() {
  if [ "${OTELDEMO_METRICS:-1}" = 0 ]; then
    set -- --set-json 'opentelemetry-collector.config.service.pipelines.metrics.exporters=["nop"]'
  else
    set --
  fi
  helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts >/dev/null 2>&1 || true
  helm repo update open-telemetry >/dev/null
  helm template otel-demo open-telemetry/opentelemetry-demo --version "$OTELDEMO_CHART_VERSION" -n "$NS" \
    --kube-version "$(k version -o json | jq -r .serverVersion.gitVersion)" -f "$VALUES" "$@" > "$MANIFEST"
}

# The sum of the render's container memory limits in MiB, each object's times its replicas (one node, so a
# DaemonSet counts once).
limits_mib() {
  awk '
    function mib(v, n) {
      gsub(/["\047]/, "", v); n = v + 0
      if (v ~ /Gi$/) return n * 1024
      if (v ~ /Mi$/) return n
      if (v ~ /Ki$/) return n / 1024
      if (v ~ /G$/) return n * 1000000000 / 1048576
      if (v ~ /M$/) return n * 1000000 / 1048576
      return n / 1048576
    }
    function flush() { total += doc * (reps == "" ? 1 : reps); doc = 0; reps = "" }
    /^---/ { flush(); lim = 0; next }
    /^  replicas:/ { reps = $2 }
    lim && match($0, /[^ ]/) <= lim { lim = 0 }
    /^ *limits:/ { lim = match($0, /[^ ]/); next }
    lim && $1 == "memory:" { doc += mib($2) }
    END { flush(); printf "%d\n", total }
  ' "$MANIFEST"
}

memory_check() {
  local need avail
  need="$(limits_mib)"
  avail="$(docker exec "$NODE" cat /proc/meminfo | awk '/^MemAvailable:/ {print int($2 / 1024)}')"
  case "$avail" in
    ''|*[!0-9]*) echo "could not read MemAvailable in $NODE: no memory check, so no up" >&2; exit 1 ;;
  esac
  echo "memory: the Docker VM has $avail MiB available (MemAvailable, /proc/meminfo in $NODE);" \
    "the demo's containers may take up to $need MiB (the memory limits in the render)"
  if [ "$avail" -lt "$need" ]; then
    echo "refusing: $((need - avail)) MiB short. Stop what else runs on the dev clusters (an e2e run, other add-ons)" \
      "or use the lighter Online Boutique described at the top of $0" >&2
    exit 1
  fi
}

# rules_loaded — whether the second cluster's Prometheus has the group of $RULES loaded, asked from its node on
# NodePort 30090 (deploy/kind/second-cluster.yaml).
rules_loaded() {
  docker exec "$NODE" curl -sf http://127.0.0.1:30090/api/v1/rules 2>/dev/null \
    | jq -e --arg g "$(jq -r '.groups[0].name' "$RULES")" 'any(.data.groups[]; .name == $g)' >/dev/null
}

# reload_prometheus present|absent — waits until the kubelet has written the ConfigMap's change into the pod (up to
# three minutes), sends SIGHUP (the Prometheus runs without --web.enable-lifecycle) and waits until the group is
# loaded or gone; fails when it is not.
reload_prometheus() {
  local _
  for _ in $(seq 1 36); do
    if [ "$1" = present ]; then
      k -n monitoring exec deploy/prometheus -- cat "/etc/prometheus/$RULES_KEY" 2>/dev/null | cmp -s - "$RULES" && break
    else
      k -n monitoring exec deploy/prometheus -- test -e "/etc/prometheus/$RULES_KEY" 2>/dev/null || break
    fi
    sleep 5
  done
  k -n monitoring exec deploy/prometheus -- kill -HUP 1 || return 1
  for _ in $(seq 1 12); do
    if [ "$1" = present ]; then rules_loaded && return 0; else rules_loaded || return 0; fi
    sleep 5
  done
  return 1
}

rules_up() {
  echo "═══ alert rules in $STORE monitoring/prometheus ($RULES_KEY) ═══"
  k -n monitoring patch configmap prometheus --type merge \
    -p "$(jq -Rs --arg k "$RULES_KEY" '{data: {($k): .}}' "$RULES")" >/dev/null
  reload_prometheus present \
    || { echo "Prometheus did not load $RULES_KEY: kubectl -n monitoring logs deploy/prometheus" >&2; exit 1; }
  echo "the alert rules are loaded; their alerts go through Alertmanager to Kubeast's webhook for cluster default"
}

rules_down() {
  [ -n "$(k -n monitoring get configmap prometheus -o json 2>/dev/null | jq -r --arg k "$RULES_KEY" '.data[$k] // empty')" ] \
    || return 0
  k -n monitoring patch configmap prometheus --type merge -p "$(jq -n --arg k "$RULES_KEY" '{data: {($k): null}}')" >/dev/null
  reload_prometheus absent \
    || echo "the Prometheus in $STORE may hold the demo's alert rules until it restarts: kubectl -n monitoring logs deploy/prometheus" >&2
}

case "$1" in
  up)
    k -n tempo get deploy tempo >/dev/null 2>&1 \
      || { echo "no Tempo in $STORE: run scripts/kind-logsearch.sh up, then scripts/kind-tracing.sh up" >&2; exit 1; }
    k -n loki get deploy loki >/dev/null 2>&1 \
      || { echo "no Loki in $STORE: run scripts/kind-logsearch.sh up" >&2; exit 1; }
    if [ "${OTELDEMO_METRICS:-1}" != 0 ]; then
      args="$(k -n monitoring get deploy prometheus -o jsonpath='{.spec.template.spec.containers[0].args}' 2>/dev/null || true)"
      case "$args" in
        *enable-remote-write-receiver*) ;;
        *) echo "the Prometheus in $STORE (monitoring/prometheus) takes no remote write: apply" \
             "deploy/kind/second-cluster.yaml there, or run with OTELDEMO_METRICS=0" >&2; exit 1 ;;
      esac
      case "$(k -n monitoring get configmap prometheus -o jsonpath='{.data.prometheus\.yml}' 2>/dev/null || true)" in
        *extra-rules-*) ;;
        *) echo "the Prometheus in $STORE reads no extra rule files, so the demo's alert rules would not load: apply" \
             "deploy/kind/second-cluster.yaml there, or run with OTELDEMO_METRICS=0" >&2; exit 1 ;;
      esac
    fi
    render
    if [ -n "$(k -n "$NS" get deploy -o name 2>/dev/null)" ]; then
      echo "the demo is already in $STORE/$NS: no memory check, applying the render again"
    else
      memory_check
    fi
    if [ -n "${OTELDEMO_NODE_HOOK:-}" ]; then $OTELDEMO_NODE_HOOK "$STORE"; fi
    echo "═══ images ═══"
    sed -n "s/^[ -]*image: *[\"']\{0,1\}\([^\"']*\)[\"']\{0,1\}$/\1/p" "$MANIFEST" | sort -u | while IFS= read -r image; do
      echo "  $image"
      import_image "$image"
    done
    echo "═══ OpenTelemetry Demo (chart $OTELDEMO_CHART_VERSION) in $STORE/$NS ═══"
    k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
    k apply --server-side --force-conflicts -n "$NS" -f "$MANIFEST" >/dev/null
    k -n "$NS" rollout status ds/otel-collector-agent --timeout=180s
    k -n "$NS" wait --for=condition=Available deploy --all --timeout=600s
    if [ "${OTELDEMO_METRICS:-1}" != 0 ]; then rules_up; else rules_down; fi
    echo "the demo is up: kubectl -n $NS port-forward svc/frontend-proxy 8080 opens the shop and /feature its flags"
    ;;
  down)
    rules_down
    render
    k delete -n "$NS" -f "$MANIFEST" --ignore-not-found --wait=false >/dev/null
    k delete namespace "$NS" --ignore-not-found
    ;;
esac
