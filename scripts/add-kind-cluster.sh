#!/usr/bin/env bash
# Spin up an extra local kind cluster and register it with kubeast as an
# EXTERNAL cluster, so you can exercise the multi-cluster paths with 3+ clusters
# without needing more real K8s servers.
#
# How the networking works: kind puts every cluster's control-plane container on
# the shared `kind` docker bridge. The kubeast pods reach external IPs through
# their own node (which is on that bridge), so they CAN reach another kind
# cluster's API at its container IP:6443. We just rewrite the kubeconfig server
# from 127.0.0.1:<hostport> to <container-ip>:6443 (and skip TLS verify, since
# the kind cert may not list that IP — fine for local dev).
#
# Usage:
#   scripts/add-kind-cluster.sh <name> [--token <admin-jwt>] [--gateway http://localhost:30080]
#   scripts/add-kind-cluster.sh test2
#
# Provide an admin JWT via --token or KUBEAST_TOKEN, or set
# KUBEAST_EMAIL/KUBEAST_PASSWORD to log in automatically.
set -euo pipefail

NAME="${1:?usage: add-kind-cluster.sh <name>}"; shift || true
GATEWAY="${KUBEAST_GATEWAY:-http://localhost:30080}"
TOKEN="${KUBEAST_TOKEN:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2;;
    --gateway) GATEWAY="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

# 1. Create the kind cluster (idempotent).
if ! kind get clusters 2>/dev/null | grep -qx "$NAME"; then
  echo "═══ creating kind cluster '$NAME' ═══"
  kind create cluster --name "$NAME"
else
  echo "kind cluster '$NAME' already exists"
fi

# 2. Resolve its control-plane IP on the shared 'kind' docker network.
CP="${NAME}-control-plane"
IP=$(docker inspect -f '{{.NetworkSettings.Networks.kind.IPAddress}}' "$CP")
[ -n "$IP" ] || { echo "could not resolve $CP IP on the kind network" >&2; exit 1; }
echo "control-plane $CP → $IP:6443"

# 3. Build an in-cluster-reachable kubeconfig (server = container IP, skip TLS).
KUBECONFIG_BLOB=$(kind get kubeconfig --name "$NAME" \
  | sed -E "s#server: https://127\.0\.0\.1:[0-9]+#server: https://${IP}:6443#" \
  | sed -E '/certificate-authority-data:/d' \
  | sed -E "s#(server: https://${IP}:6443)#\1\n    insecure-skip-tls-verify: true#")

# 4. Get an admin token if not supplied.
if [ -z "$TOKEN" ]; then
  if [ -n "${KUBEAST_EMAIL:-}" ] && [ -n "${KUBEAST_PASSWORD:-}" ]; then
    TOKEN=$(curl -s -X POST -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg e "$KUBEAST_EMAIL" --arg p "$KUBEAST_PASSWORD" '{email:$e,password:$p}')" \
      "$GATEWAY/api/v1/auth/login" | jq -r '.access_token')
  fi
fi
[ -n "$TOKEN" ] || { echo "no admin token — pass --token or set KUBEAST_EMAIL/PASSWORD" >&2; exit 1; }

# 5. Register with kubeast as an external cluster.
echo "═══ registering '$NAME' with kubeast ═══"
BODY=$(jq -nc --arg n "$NAME" --arg kc "$KUBECONFIG_BLOB" \
  '{mode:"external", display_name:$n, kubeconfig:$kc}')
RESP=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "$BODY" "$GATEWAY/api/v1/clusters")
CODE=$(echo "$RESP" | tail -1); JSON=$(echo "$RESP" | sed '$d')
echo "HTTP $CODE: $JSON"
[ "$CODE" = "201" ] || { echo "registration failed" >&2; exit 1; }
echo "✓ '$NAME' registered — switch to it in the cluster picker."
