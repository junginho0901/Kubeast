#!/usr/bin/env bash
# Kubeast's resource footprint, measured on kind: a kind cluster of its own (kubeast-fp, apart from the dev clusters)
# with the chart installed from helm/kubeast/values-minimal.yaml, sampled once a minute with crictl — each container's
# memory working set (what `kubectl top` and the kubelet report, not RSS) and its CPU from the usage counter. The
# README footprint table comes from these runs.
#
#   scripts/kind-footprint.sh up                          # cluster + minimal install (images kubeast/*:$IMAGE_TAG from the host)
#   scripts/kind-footprint.sh step <label> <min> [helm…]  # helm upgrade with these --set args on top of the previous
#                                                         # step, wait for the pods, settle 3 minutes, sample <min> minutes
#   scripts/kind-footprint.sh measure <label> <min>       # sample the install as it is
#   scripts/kind-footprint.sh load <label> <min>          # sample while list APIs are called in a loop (in use)
#   scripts/kind-footprint.sh check                       # the load pass's APIs and their status codes
#   scripts/kind-footprint.sh summary <label>             # print the summary of a saved run again
#   scripts/kind-footprint.sh down
#
# Each run writes $OUT/<label>.csv (minute,pod,container,working_set_mib,cpu_millicores) and prints per container
# the first, 90th percentile and highest working set, the change over the last 10 minutes, and CPU.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER="${FP_CLUSTER:-kubeast-fp}"
NODE="$CLUSTER-control-plane"
NS="kubeast"
RELEASE="kubeast"
IMAGE_TAG="${IMAGE_TAG:-local}"
OUT="${FP_OUT:-$ROOT/.footprint}"
KC="$OUT/kubeconfig"
SETTLE_SECONDS="${FP_SETTLE_SECONDS:-180}"
mkdir -p "$OUT"

helm_fp() { helm --kubeconfig "$KC" -n "$NS" "$@"; }
kubectl_fp() { kubectl --kubeconfig "$KC" -n "$NS" "$@"; }

# Sample every minute for $2 minutes into $OUT/$1.csv. CPU is the usage counter's rise over the minute.
sample() {
  local label="$1" minutes="$2" csv="$OUT/$1.csv"
  echo "minute,pod,container,working_set_mib,cpu_millicores" > "$csv"
  local prev="$OUT/.prev.json"
  rm -f "$prev"
  for ((m = 0; m <= minutes; m++)); do
    docker exec "$NODE" crictl stats -o json --label "io.kubernetes.pod.namespace=$NS" > "$OUT/.now.json"
    python3 - "$m" "$OUT/.now.json" "$prev" >> "$csv" <<'EOF'
import json, os, sys
minute, now_path, prev_path = int(sys.argv[1]), sys.argv[2], sys.argv[3]
def load(p):
    out = {}
    for s in json.load(open(p))["stats"]:
        if "cpu" not in s or "memory" not in s:
            continue  # a stopped container
        l = s["attributes"]["labels"]
        out[(l["io.kubernetes.pod.name"], l["io.kubernetes.container.name"])] = (
            int(s["cpu"]["timestamp"]), int(s["cpu"]["usageCoreNanoSeconds"]["value"]),
            int(s["memory"]["workingSetBytes"]["value"]))
    return out
now = load(now_path)
prev = load(prev_path) if os.path.exists(prev_path) else {}
for (pod, container), (ts, cpu, ws) in sorted(now.items()):
    mc = ""
    if (pod, container) in prev:
        pts, pcpu, _ = prev[(pod, container)]
        if ts > pts:
            mc = f"{(cpu - pcpu) / (ts - pts) * 1000:.1f}"
    print(f"{minute},{pod},{container},{ws / 1048576:.1f},{mc}")
EOF
    mv "$OUT/.now.json" "$prev"
    if ((m < minutes)); then sleep 60; fi
  done
  summary "$label"
}

summary() {
  python3 - "$OUT/$1.csv" <<'EOF'
import csv, sys
from collections import defaultdict
rows = list(csv.DictReader(open(sys.argv[1])))
ws, cpu = defaultdict(list), defaultdict(list)
for r in rows:
    k = r["container"]
    ws[k].append((int(r["minute"]), float(r["working_set_mib"])))
    if r["cpu_millicores"]:
        cpu[k].append(float(r["cpu_millicores"]))
def p90(v):
    v = sorted(v)
    return v[min(len(v) - 1, int(round(0.9 * (len(v) - 1))))] if v else 0.0
print(f"{sys.argv[1]}  ({max(m for m, _ in sum(ws.values(), []))} min)")
print(f"{'container':<28}{'first':>8}{'p90':>8}{'max':>8}{'last10':>8}{'cpu p90':>9}{'cpu max':>9}  (MiB, millicores)")
tot = [0.0] * 6
for k in sorted(ws):
    vals = [v for _, v in ws[k]]
    last = max(m for m, _ in ws[k])
    window = [v for m, v in ws[k] if m >= last - 10]
    row = [vals[0], p90(vals), max(vals), window[-1] - window[0], p90(cpu[k]), max(cpu[k] or [0.0])]
    tot = [a + b for a, b in zip(tot, row)]
    print(f"{k:<28}" + "".join(f"{x:>8.1f}" if i < 4 else f"{x:>9.1f}" for i, x in enumerate(row)))
print(f"{'total':<28}" + "".join(f"{x:>8.1f}" if i < 4 else f"{x:>9.1f}" for i, x in enumerate(tot)))
EOF
}

# The images the install needs that are not kubeast/*: a kind node pulls them itself; where it cannot (a proxy),
# they are imported from the host's docker, as scripts/kind-deploy.sh does.
import_images() {
  helm template "$RELEASE" "$ROOT/helm/kubeast" -n "$NS" -f "$ROOT/helm/kubeast/values-minimal.yaml" \
    --set redis.enabled=true --set ai.enabled=true 2>/dev/null \
    | sed -n 's/^ *image: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | sort -u | grep -v "^kubeast/" \
    | while IFS= read -r image; do
      docker exec "$NODE" crictl pull "docker.io/$image" >/dev/null 2>&1 && continue
      docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
      docker save "$image" | docker exec --privileged -i "$NODE" \
        ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
    done
}

wait_ready() {
  kubectl_fp wait --for=condition=Available deploy --all --timeout=300s >/dev/null
  kubectl_fp get pods --no-headers | awk '{print "  " $1 " " $2 " " $3}'
}

# Run a shell script in the node with $base (the gateway's NodePort) and $token (the admin signed in); the admin
# password goes through the environment, not the command line.
in_node() {
  PW="$(kubectl_fp get secret kubeast-secrets -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d)" \
    docker exec -e PW -e PORT="$(kubectl_fp get service gateway -o jsonpath='{.spec.ports[0].nodePort}')" "$@" "$NODE" sh -c '
      base="http://127.0.0.1:$PORT"
      token=$(curl -s -X POST "$base/api/v1/auth/login" -H "Content-Type: application/json" \
        -d "{\"email\":\"admin\",\"password\":\"$PW\"}" | sed -n "s/.*\"access_token\":\"\([^\"]*\)\".*/\1/p")
      [ -n "$token" ] || { echo "login failed" >&2; exit 1; }
      api() { curl -s -H "Authorization: Bearer $token" -H "X-Requested-With: XMLHttpRequest" "$@"; }
      eval "$SCRIPT"'
}

case "${1:-}" in
  up)
    kind get clusters 2>/dev/null | grep -x "$CLUSTER" >/dev/null || kind create cluster --name "$CLUSTER" --kubeconfig "$KC"
    kind export kubeconfig --name "$CLUSTER" --kubeconfig "$KC" >/dev/null 2>&1
    for name in auth-service k8s-service session-service frontend ai-service tool-server model-config-controller-go; do
      kind load docker-image "kubeast/$name:$IMAGE_TAG" --name "$CLUSTER" >/dev/null 2>&1
    done
    import_images
    helm_fp upgrade --install "$RELEASE" "$ROOT/helm/kubeast" --create-namespace \
      -f "$ROOT/helm/kubeast/values-minimal.yaml" \
      --set global.imageTag="$IMAGE_TAG" --set global.imagePullPolicy=IfNotPresent \
      --set images.frontend=kubeast/frontend --set images.authService=kubeast/auth-service \
      --set images.aiService=kubeast/ai-service --set images.k8sService=kubeast/k8s-service \
      --set images.sessionService=kubeast/session-service --set images.toolServer=kubeast/tool-server \
      --set images.modelConfigController=kubeast/model-config-controller-go \
      --wait --timeout 10m | grep -E "REVISION|STATUS"
    wait_ready
    # The setup wizard's first step: this cluster as the managed one (409 = done before). It restarts k8s-service.
    in_node -e SCRIPT='api -o /dev/null -w "setup %{http_code}\n" -X POST "$base/api/v1/auth/setup" \
      -H "Content-Type: application/json" -d "{\"mode\":\"in_cluster\"}"'
    sleep 5
    kubectl_fp rollout status deploy/k8s-service --timeout=180s >/dev/null
    wait_ready
    ;;
  step)
    label="$2" minutes="$3"; shift 3
    helm_fp upgrade "$RELEASE" "$ROOT/helm/kubeast" --reset-then-reuse-values "$@" --wait --timeout 10m | grep -E "REVISION|STATUS"
    wait_ready
    sleep "$SETTLE_SECONDS"
    sample "$label" "$minutes"
    ;;
  measure) sample "$2" "$3" ;;
  load)
    label="$2" minutes="$3"
    # A loop in the node that ends on its own after the run (a process started through docker exec keeps running
    # when the client goes away): four callers over the screens' list APIs.
    in_node -e SECS="$(((minutes + 1) * 60))" -e SCRIPT='
      end=$(( $(date +%s) + SECS ))
      for w in 1 2 3 4; do
        ( while [ "$(date +%s)" -lt "$end" ]; do
            for p in cluster/overview cluster/nodes cluster/events cluster/namespaces/kube-system/pods \
                     cluster/namespaces/kubeast/pods cluster/namespaces/kube-system/deployments cluster/hygiene \
                     "auth/admin/audit-logs?limit=50" sessions; do
              api -o /dev/null "$base/api/v1/$p"
            done
          done ) &
      done
      wait' &
    loader=$!
    sample "$label" "$minutes"
    wait "$loader" || true
    ;;
  check)
    # Each list API the load pass calls, with its status (all 200 on a set-up install).
    in_node -e SCRIPT='for p in cluster/overview cluster/nodes cluster/events cluster/namespaces/kube-system/pods \
        cluster/namespaces/kubeast/pods cluster/namespaces/kube-system/deployments cluster/hygiene \
        "auth/admin/audit-logs?limit=50" sessions; do
        echo "$(api -o /dev/null -w "%{http_code}" "$base/api/v1/$p") $p"; done'
    ;;
  summary) summary "$2" ;;
  down) kind delete cluster --name "$CLUSTER" ;;
  *) sed -n '2,18p' "$0" >&2; exit 2 ;;
esac
