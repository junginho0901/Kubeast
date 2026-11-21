#!/bin/bash
# api-snapshot.sh — capture / diff API response snapshots for refactor regression detection.
#
# Auto-extracts every `r.Get("...")` route from
# services/k8s-service-go/internal/routes/*.go. For each endpoint:
#   - Substitutes {namespace} with the fixture namespace (default: clarinet).
#   - Skips endpoints with other path parameters ({name}, {kind}, ...) —
#     they need cluster-state-aware fixtures we don't have.
#   - GETs via the gateway, normalizes volatile fields (timestamps, uids,
#     resourceVersion, managedFields, ...) with jq.
#   - Writes <output>/<sanitized-path>.json + a skipped.txt log.
#
# Usage:
#   bash scripts/api-snapshot.sh capture <out-dir>
#   bash scripts/api-snapshot.sh diff <baseline-dir> <actual-dir>
#
# Auth: requires E2E_USER_EMAIL / E2E_USER_PASSWORD; logs in via
# /api/v1/auth/login and uses the token of the answer's Set-Cookie header as Bearer.
#
# Env knobs:
#   E2E_BASE_URL       gateway URL, default http://localhost:30080
#   API_SNAPSHOT_NS    fixture namespace, default clarinet
#   AUTH_COOKIE_NAME   the install's sign-in cookie name, read before kubeast.token (scripts/session-token.awk)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROUTES_DIR="$ROOT/services/k8s-service-go/internal/routes"
BASE_URL="${E2E_BASE_URL:-http://localhost:30080}"
NS_FIXTURE="${API_SNAPSHOT_NS:-clarinet}"

usage() {
  cat <<EOF
usage:
  $0 capture <out-dir>
  $0 diff <baseline-dir> <actual-dir>
EOF
  exit 1
}

[[ $# -ge 1 ]] || usage
MODE="$1"
shift

case "$MODE" in
  capture)
    [[ $# -eq 1 ]] || usage
    OUT="$1"
    : "${E2E_USER_EMAIL:?missing E2E_USER_EMAIL}"
    : "${E2E_USER_PASSWORD:?missing E2E_USER_PASSWORD}"

    mkdir -p "$OUT"
    SKIPPED="$OUT/skipped.txt"
    : > "$SKIPPED"

    # Login → Bearer token.
    LOGIN_BODY=$(jq -nc --arg e "$E2E_USER_EMAIL" --arg p "$E2E_USER_PASSWORD" \
      '{email:$e,password:$p}')
    LOGIN_HEADERS=$(curl -sf -o /dev/null -D - -H 'Content-Type: application/json' \
      -d "$LOGIN_BODY" "$BASE_URL/api/v1/auth/login") || {
      echo "ERROR: login failed against $BASE_URL/api/v1/auth/login" >&2
      exit 1
    }
    TOKEN=$(printf '%s\n' "$LOGIN_HEADERS" | awk -f "$ROOT/scripts/session-token.awk")
    if [[ -z "$TOKEN" ]]; then
      echo "ERROR: login answer set no ${AUTH_COOKIE_NAME:+${AUTH_COOKIE_NAME}, __Host-${AUTH_COOKIE_NAME}, }kubeast.token or __Host-kubeast.token cookie" >&2
      exit 1
    fi

    # Extract unique GET paths from routes/*.go.
    PATHS=$(grep -h -oE 'r\.Get\("[^"]+"' "$ROUTES_DIR"/*.go \
      | sed -E 's/r\.Get\("//; s/"$//' \
      | sort -u)

    TOTAL=0
    OK=0
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      TOTAL=$((TOTAL + 1))

      # Substitute {namespace} → fixture; skip if any other {param} remains.
      sub="${path//\{namespace\}/$NS_FIXTURE}"
      if [[ "$sub" == *"{"* ]]; then
        echo "$path  (unsupported path params)" >> "$SKIPPED"
        continue
      fi

      # WebSocket / streaming endpoints — not snapshottable via plain GET.
      if [[ "$sub" == *"/ws"* || "$sub" == *"/exec"* || "$sub" == *"/logs"* \
            || "$sub" == *"/watch"* || "$sub" == "/api/v1/wsMultiplexer" ]]; then
        echo "$path  (ws/streaming)" >> "$SKIPPED"
        continue
      fi

      fname="$(echo "$sub" | sed 's|^/||; s|/|_|g; s|?.*$||').json"
      raw="$OUT/$fname.raw"
      out="$OUT/$fname"

      status=$(curl -s --max-time 15 -o "$raw" -w "%{http_code}" \
        -H "Authorization: Bearer $TOKEN" "$BASE_URL$sub" || echo "000")

      if [[ "$status" != "200" ]]; then
        echo "$path  -> HTTP $status" >> "$SKIPPED"
        rm -f "$raw"
        continue
      fi

      # Normalize: jq -S sort object keys, strip volatile fields, and
      # sort arrays (Kubernetes / Go map iteration ordering is
      # non-deterministic — same data yields different array order
      # between calls). Sorting trades order-meaningful diffs (e.g.
      # timeline ordering) for stability; e2e visual tests catch the
      # former.
      if ! jq -S '
        def scrub:
          if type == "object" then
            with_entries(
              select(.key as $k | [
                "resourceVersion","uid","creationTimestamp","managedFields",
                "lastTransitionTime","lastUpdateTime","lastHeartbeatTime",
                "lastProbeTime","generation","observedGeneration","selfLink",
                "startTime","deletionTimestamp","deletionGracePeriodSeconds"
              ] | index($k) | not)
              | .value |= scrub
            )
          elif type == "array" then
            map(scrub) | sort_by(tostring)
          else . end;
        scrub
      ' "$raw" > "$out" 2>/dev/null; then
        # Non-JSON response (e.g. plain text from /describe). Keep as-is.
        mv "$raw" "$out"
      else
        rm -f "$raw"
      fi
      OK=$((OK + 1))
    done <<< "$PATHS"

    echo "captured $OK / $TOTAL endpoints into $OUT"
    SKIPPED_COUNT=$(wc -l < "$SKIPPED" | tr -d ' ')
    echo "skipped $SKIPPED_COUNT (see $SKIPPED)"
    ;;

  diff)
    [[ $# -eq 2 ]] || usage
    BASELINE="$1"
    ACTUAL="$2"
    [[ -d "$BASELINE" ]] || { echo "missing baseline dir: $BASELINE" >&2; exit 1; }
    [[ -d "$ACTUAL"   ]] || { echo "missing actual dir: $ACTUAL"   >&2; exit 1; }

    DIFFS=0
    while IFS= read -r f; do
      name="$(basename "$f")"
      [[ "$name" == "skipped.txt" ]] && continue
      if [[ ! -f "$ACTUAL/$name" ]]; then
        echo "MISSING in actual: $name"
        DIFFS=$((DIFFS + 1))
        continue
      fi
      if ! diff -q "$f" "$ACTUAL/$name" >/dev/null; then
        echo "CHANGED: $name"
        diff "$f" "$ACTUAL/$name" | head -40
        echo "---"
        DIFFS=$((DIFFS + 1))
      fi
    done < <(find "$BASELINE" -maxdepth 1 -name '*.json' -type f | sort)

    while IFS= read -r f; do
      name="$(basename "$f")"
      [[ "$name" == "skipped.txt" ]] && continue
      if [[ ! -f "$BASELINE/$name" ]]; then
        echo "NEW in actual: $name"
        DIFFS=$((DIFFS + 1))
      fi
    done < <(find "$ACTUAL" -maxdepth 1 -name '*.json' -type f | sort)

    if [[ $DIFFS -eq 0 ]]; then
      echo "OK: all snapshots match"
      exit 0
    fi
    echo "REGRESSION: $DIFFS difference(s)"
    exit 1
    ;;

  *)
    usage
    ;;
esac
