#!/usr/bin/env bash
# Network flows from Calico on kind: a kind cluster kubeast-calico (a control plane and a worker, no default CNI —
# deploy/kind/calico-kind.yaml) running Calico through the Tigera operator with Goldmane and Whisker
# (deploy/kind/calico-resources.yaml), the policy that lets the API server reach Whisker
# (deploy/kind/calico-whisker-apiserver.yaml), the traffic of deploy/kind/cilium-demo.yaml (Calico enforces its
# NetworkPolicy), registered with Kubeast under its own name, the Whisker Role from
# templates/impersonation-viewer-whisker.yaml, and the cluster added to features.networkFlows.clusters as calico next
# to the clusters already there.
#
#   scripts/kind-calico.sh up       # creates the cluster, or starts it when stopped
#   scripts/kind-calico.sh down     # takes the cluster out of features.networkFlows, unregisters it and stops it (kept: up registers it again)
#   scripts/kind-calico.sh delete   # down and delete the cluster
#
# Behind a TLS-inspecting proxy set CALICO_NODE_HOOK to a command that gets a node container's name and makes it
# trust the proxy (run on each node right after the cluster is created).
# The admin token comes from KUBEAST_TOKEN, KUBEAST_EMAIL/KUBEAST_PASSWORD, or the dev install's Secret.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${CALICO_CLUSTER:-kubeast-calico}"
CALICO_VERSION="v3.33.0"
MAIN="${KIND_CLUSTER_NAME:-kubeast}"
NAMESPACE="${KUBEAST_NAMESPACE:-kubeast}"
RELEASE="${KUBEAST_RELEASE:-kubeast}"
GATEWAY="${KUBEAST_GATEWAY:-http://localhost:30080}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"
MANIFESTS="https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests"

KC="$(mktemp)"
trap 'rm -f "$KC"' EXIT
ck() { kubectl --kubeconfig "$KC" "$@"; }
main_kubectl() { kubectl --kubeconfig "$KUBECONFIG_PATH" --context "kind-$MAIN" "$@"; }
main_helm() { helm --kubeconfig "$KUBECONFIG_PATH" --kube-context "kind-$MAIN" -n "$NAMESPACE" "$@"; }

token() {
  if [ -n "${KUBEAST_TOKEN:-}" ]; then echo "$KUBEAST_TOKEN"; return; fi
  local email="${KUBEAST_EMAIL:-admin}" password="${KUBEAST_PASSWORD:-}"
  if [ -z "$password" ]; then
    password=$(main_kubectl -n "$NAMESPACE" get secret kubeast-secrets -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d)
  fi
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg e "$email" --arg p "$password" '{email:$e,password:$p}')" "$GATEWAY/api/v1/auth/login" | jq -r '.access_token'
}

registered_id() { # the Kubeast cluster whose name is $NAME, if any
  curl -s -H "Authorization: Bearer $1" "$GATEWAY/api/v1/clusters" | jq -r --arg n "$NAME" '(.items // .)[] | select(.display_name == $n or .id == $n) | .id' | head -1
}

case "${1:-}" in
  up)
    if ! kind get clusters 2>/dev/null | grep -x "$NAME" >/dev/null; then
      echo "═══ creating kind cluster $NAME ═══"
      kind create cluster --name "$NAME" --config "$ROOT/deploy/kind/calico-kind.yaml" --kubeconfig "$KC"
      if [ -n "${CALICO_NODE_HOOK:-}" ]; then
        for node in $(kind get nodes --name "$NAME"); do $CALICO_NODE_HOOK "$node"; done
      fi
    else
      for node in $(kind get nodes --name "$NAME"); do
        [ "$(docker inspect -f '{{.State.Running}}' "$node")" = "true" ] || { echo "═══ starting $node ═══"; docker start "$node" >/dev/null; }
      done
    fi
    kind get kubeconfig --name "$NAME" > "$KC"
    for _ in $(seq 1 60); do ck get --raw /readyz >/dev/null 2>&1 && break; sleep 2; done

    echo "═══ Calico $CALICO_VERSION (Tigera operator), Goldmane and Whisker ═══"
    # as Calico's upgrade steps apply them, so a second up on the same cluster works too
    ck apply --server-side --force-conflicts -f "$MANIFESTS/operator-crds.yaml" >/dev/null
    ck apply --server-side --force-conflicts -f "$MANIFESTS/tigera-operator.yaml" >/dev/null
    ck -n tigera-operator rollout status deploy/tigera-operator --timeout=300s
    ck apply -f "$ROOT/deploy/kind/calico-resources.yaml" >/dev/null
    for _ in $(seq 1 90); do
      ck -n calico-system get deploy whisker >/dev/null 2>&1 && ck get crd networkpolicies.projectcalico.org >/dev/null 2>&1 && break
      sleep 5
    done
    ck -n calico-system rollout status deploy/whisker deploy/goldmane --timeout=600s
    ck apply -f "$ROOT/deploy/kind/calico-whisker-apiserver.yaml" >/dev/null
    ck apply -f "$ROOT/deploy/kind/cilium-demo.yaml" >/dev/null
    ck -n flows-demo rollout status deploy/web deploy/client deploy/stranger --timeout=300s

    TOKEN="$(token)"
    if [ -z "$(registered_id "$TOKEN")" ]; then
      echo "═══ registering $NAME with Kubeast ═══"
      ck apply -f "$ROOT/helm/kubeast/files/impersonation-rbac.yaml" >/dev/null
      BODY=$(jq -nc --arg n "$NAME" --arg kc "$(kind get kubeconfig --internal --name "$NAME")" '{mode:"external", display_name:$n, kubeconfig:$kc}')
      CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY" "$GATEWAY/api/v1/clusters")
      [ "$CODE" = "201" ] || { echo "registration failed: HTTP $CODE" >&2; exit 1; }
    fi
    ID="$(registered_id "$TOKEN")"
    helm template "$RELEASE" "$ROOT/helm/kubeast" -s templates/impersonation-viewer-whisker.yaml -f "$ROOT/deploy/kind/values.yaml" \
      --set features.networkFlows.enabled=true --set "features.networkFlows.clusters.$ID=calico" \
      --set features.networkFlows.whisker=calico-system/whisker:8443 | ck apply -f - >/dev/null
    echo "═══ Kubeast: features.networkFlows adds cluster $ID (calico) ═══"
    main_helm upgrade "$RELEASE" "$ROOT/helm/kubeast" --reset-then-reuse-values \
      --set features.networkFlows.enabled=true --set "features.networkFlows.clusters.$ID=calico" \
      --wait --timeout 5m | grep -E "REVISION|STATUS"
    main_kubectl -n "$NAMESPACE" rollout status deploy/k8s-service --timeout=180s
    echo "═══ network flows on: cluster $ID, namespace flows-demo (web, client, stranger) ═══"
    ;;
  down|delete)
    TOKEN="$(token)"
    ID="$(registered_id "$TOKEN")"
    if [ -n "$ID" ] && main_helm status "$RELEASE" >/dev/null 2>&1; then
      main_helm upgrade "$RELEASE" "$ROOT/helm/kubeast" --reset-then-reuse-values --set "features.networkFlows.clusters.$ID=null" \
        --wait --timeout 5m | grep -E "REVISION|STATUS"
    fi
    # unregistered on down too: a stopped cluster left registered fails every read that goes to all clusters
    if [ -n "$ID" ]; then
      curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "$GATEWAY/api/v1/clusters/$ID"
    fi
    if [ "$1" = delete ]; then
      kind delete cluster --name "$NAME" --kubeconfig "$KC"
    else
      for node in $(kind get nodes --name "$NAME" 2>/dev/null); do docker stop "$node" >/dev/null; done
    fi
    ;;
  *)
    echo "usage: $0 up|down|delete" >&2
    exit 2
    ;;
esac
