#!/usr/bin/env bash
# Network flows, drops and Resource Graph traffic lines from Microsoft Retina on kind: a kind cluster with kind's own
# CNI (kubeast-retina) running Retina's Hubble control plane (deploy/kind/retina-values.yaml — the Relay over TLS, the
# Hubble drop and TCP metrics with workload labels), the Prometheus of deploy/kind/cilium-prometheus.yaml, the
# traffic of deploy/kind/cilium-demo.yaml (kindnet enforces its NetworkPolicy), registered with Kubeast under its
# own name, the Relay and Prometheus Roles as scripts/kind-cilium.sh does, and the cluster added to
# features.networkFlows.clusters next to the ones already there.
#
#   scripts/kind-retina.sh up       # creates the cluster, or starts it when stopped
#   scripts/kind-retina.sh down     # takes the cluster out of features.networkFlows, unregisters it and stops it (kept: up registers it again)
#   scripts/kind-retina.sh delete   # down and delete the cluster
#
# Behind a TLS-inspecting proxy set RETINA_NODE_HOOK to a command that gets the cluster name and makes the node
# trust the proxy (run right after the cluster is created), as CILIUM_NODE_HOOK for scripts/kind-cilium.sh.
# The admin token comes from KUBEAST_TOKEN, KUBEAST_EMAIL/KUBEAST_PASSWORD, or the dev install's Secret.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${RETINA_CLUSTER:-kubeast-retina}"
RETINA_VERSION="v1.3.0"
MAIN="${KIND_CLUSTER_NAME:-kubeast}"
NAMESPACE="${KUBEAST_NAMESPACE:-kubeast}"
RELEASE="${KUBEAST_RELEASE:-kubeast}"
GATEWAY="${KUBEAST_GATEWAY:-http://localhost:30080}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"
CP="$NAME-control-plane"

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
      kind create cluster --name "$NAME" --kubeconfig "$KC"
      if [ -n "${RETINA_NODE_HOOK:-}" ]; then $RETINA_NODE_HOOK "$NAME"; fi
    elif [ "$(docker inspect -f '{{.State.Running}}' "$CP")" != "true" ]; then
      echo "═══ starting $NAME ═══"
      docker start "$CP" >/dev/null
    fi
    kind get kubeconfig --name "$NAME" > "$KC"
    for _ in $(seq 1 60); do ck get --raw /readyz >/dev/null 2>&1 && break; sleep 2; done

    echo "═══ Retina $RETINA_VERSION, Hubble control plane: Relay over TLS, drop and TCP metrics ═══"
    helm --kubeconfig "$KC" -n kube-system upgrade --install retina oci://ghcr.io/microsoft/retina/charts/retina-hubble \
      --version "$RETINA_VERSION" -f "$ROOT/deploy/kind/retina-values.yaml" >/dev/null
    ck -n kube-system rollout status ds/retina-agent --timeout=600s
    ck -n kube-system rollout status deploy/hubble-relay --timeout=600s
    ck apply -f "$ROOT/deploy/kind/cilium-prometheus.yaml" >/dev/null
    ck apply -f "$ROOT/deploy/kind/cilium-demo.yaml" >/dev/null
    ck -n monitoring rollout status deploy/prometheus --timeout=300s
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
    helm template "$RELEASE" "$ROOT/helm/kubeast" -s templates/impersonation-viewer-hubble.yaml \
      -f "$ROOT/deploy/kind/values.yaml" -f "$ROOT/deploy/kind/networkflows-values.yaml" | ck apply -f - >/dev/null
    helm template "$RELEASE" "$ROOT/helm/kubeast" -s templates/impersonation-viewer-proxy.yaml -f "$ROOT/deploy/kind/values.yaml" \
      --set-json 'auth.impersonation.viewerProxyServices=[{"namespace":"monitoring","service":"prometheus","port":9090}]' | ck apply -f - >/dev/null
    echo "═══ Kubeast: features.networkFlows adds cluster $ID ═══"
    main_helm upgrade "$RELEASE" "$ROOT/helm/kubeast" --reset-then-reuse-values \
      --set features.networkFlows.enabled=true --set "features.networkFlows.clusters.$ID=proxy" \
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
    elif docker inspect "$CP" >/dev/null 2>&1; then
      docker stop "$CP" >/dev/null
    fi
    ;;
  *)
    echo "usage: $0 up|down|delete" >&2
    exit 2
    ;;
esac
