#!/usr/bin/env bash
# Render every RBAC object a registered cluster needs from Kubeast — the
# impersonation roles, custom roles, the Read group's proxy Roles and the log
# files grant — from the install values plus that cluster's own overlay, so a
# single apply covers the cluster:
#
#   scripts/render-target-rbac.sh -f values.yaml -f cluster-b.yaml | kubectl --context cluster-b apply -f -
#
# Extra arguments go to `helm template` as they are (`--set`, `--version` with
# KUBEAST_CHART=oci://…). A template that renders nothing for these values (no
# custom roles, no proxy services, log files off) is skipped with a note on
# stderr: helm fails on an empty --show-only, so each template is rendered on
# its own. Any other helm error stops the script. docs/cluster-requirements.md §1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHART="${KUBEAST_CHART:-$ROOT/helm/kubeast}"
TEMPLATES=(impersonation-rbac impersonation-custom-roles impersonation-viewer-proxy logfiles-rbac)

if [ $# -eq 0 ]; then
  echo "usage: $0 -f <values.yaml> [-f <cluster values.yaml>] [helm template flags]" >&2
  exit 2
fi

for t in "${TEMPLATES[@]}"; do
  if out=$(helm template kubeast "$CHART" --show-only "templates/$t.yaml" "$@" 2>&1); then
    printf '%s\n' "$out"
  elif grep -q "could not find template templates/$t.yaml" <<<"$out"; then
    echo "skipped templates/$t.yaml: renders nothing for these values" >&2
  else
    printf '%s\n' "$out" >&2
    exit 1
  fi
done
