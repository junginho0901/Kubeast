#!/usr/bin/env bash
# test-helm-watch.sh — manual smoke test for the Helm release WebSocket
# watch endpoint (replaces the prior 30s polling on the Releases page).
#
# Verifies that:
#   1. WebSocket /api/v1/helm/releases/watch upgrades successfully.
#   2. helm install fires ADDED events within ~2s.
#   3. helm uninstall fires DELETED events within ~2s.
#
# Requirements: kubectl, helm, websocat (https://github.com/vi/websocat).
# Auth: relies on a valid session cookie at $COOKIE_FILE — re-run after
# logging in to the UI and exporting the cookie via:
#   curl --cookie-jar /tmp/kubeast-cookie http://localhost:8000/api/v1/auth/login ...
#
# Usage:
#   scripts/test-helm-watch.sh [--gateway http://host:port] [--namespace ns]

set -euo pipefail

GATEWAY="${GATEWAY:-http://localhost:8000}"
NAMESPACE="${NAMESPACE:-default}"
COOKIE_FILE="${COOKIE_FILE:-/tmp/kubeast-cookie}"
RELEASE_NAME="${RELEASE_NAME:-watch-smoketest}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway) GATEWAY="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --cookie) COOKIE_FILE="$2"; shift 2 ;;
    --release) RELEASE_NAME="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,17p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if ! command -v websocat >/dev/null 2>&1; then
  echo "websocat is required (brew install websocat or cargo install websocat)" >&2
  exit 1
fi

if ! command -v helm >/dev/null 2>&1; then
  echo "helm is required" >&2
  exit 1
fi

if [[ ! -f "$COOKIE_FILE" ]]; then
  echo "cookie file not found: $COOKIE_FILE" >&2
  echo "Login via the UI first, then export the session cookie to that path." >&2
  exit 1
fi

WS_URL="${GATEWAY/http/ws}/api/v1/helm/releases/watch?cluster=default&namespace=${NAMESPACE}"
EVENT_LOG="$(mktemp -t helm-watch-events.XXXXXX)"

echo "═══ opening WS to ${WS_URL} ═══"
COOKIE_HEADER="Cookie: $(awk '!/^#/ && NF==7 {print $6"="$7}' "$COOKIE_FILE" | paste -sd';' -)"
websocat --header "$COOKIE_HEADER" "$WS_URL" >"$EVENT_LOG" &
WS_PID=$!
trap 'kill "$WS_PID" 2>/dev/null || true; rm -f "$EVENT_LOG"' EXIT

# Give the WS a moment to attach.
sleep 1
if ! kill -0 "$WS_PID" 2>/dev/null; then
  echo "WS process died early — check auth / gateway URL" >&2
  cat "$EVENT_LOG" >&2
  exit 1
fi

echo "═══ helm install ${RELEASE_NAME} → expect ADDED within 2s ═══"
helm install "$RELEASE_NAME" \
  oci://registry-1.docker.io/bitnamicharts/nginx \
  --namespace "$NAMESPACE" --wait --timeout 60s >/dev/null

sleep 2
if ! grep -q '"type":"ADDED"' "$EVENT_LOG"; then
  echo "FAIL: no ADDED event observed" >&2
  echo "--- ws log ---" >&2
  cat "$EVENT_LOG" >&2
  exit 1
fi
echo "PASS: ADDED received"

echo "═══ helm uninstall ${RELEASE_NAME} → expect DELETED within 2s ═══"
helm uninstall "$RELEASE_NAME" --namespace "$NAMESPACE" >/dev/null

sleep 2
if ! grep -q '"type":"DELETED"' "$EVENT_LOG"; then
  echo "FAIL: no DELETED event observed" >&2
  echo "--- ws log ---" >&2
  cat "$EVENT_LOG" >&2
  exit 1
fi
echo "PASS: DELETED received"

echo "═══ all checks passed ═══"
