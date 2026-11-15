#!/usr/bin/env bash
# Prints the key paths of a values file as Helm reads it, one per line (a.b.c; nothing under a list).
#   scripts/values-paths.sh FILE            every path, maps included
#   scripts/values-paths.sh --leaves FILE   only paths that hold a value (not a map with keys)
#   scripts/values-paths.sh --json FILE     the values as one line of JSON
# Needs helm and jq. Used by scripts/check-docs-pair.sh and scripts/chart-removed-values.sh.
set -euo pipefail
mode=all
case ${1:-} in --leaves|--json) mode=${1#--}; shift ;; esac
[ $# -eq 1 ] && [ -f "$1" ] || { echo "usage: $0 [--leaves|--json] FILE" >&2; exit 2; }
chart=$(mktemp -d)
trap 'rm -rf "$chart"' EXIT
mkdir "$chart/templates"
printf 'apiVersion: v2\nname: values-paths\nversion: 0.0.0\n' > "$chart/Chart.yaml"
printf '# {{ toJson .Values }}\n' > "$chart/templates/values.yaml"
json=$(helm template values-paths "$chart" -f "$1" | sed -n 's/^# {/{/p')
[ -n "$json" ] || { echo "$0: $1 did not render" >&2; exit 1; }
case $mode in
  json) echo "$json" ;;
  leaves) jq -r 'path(.. | select(type != "object" or length == 0)) | select(length > 0 and all(.[]; type == "string")) | join(".")' <<<"$json" ;;
  all) jq -r 'path(..) | select(length > 0 and all(.[]; type == "string")) | join(".")' <<<"$json" ;;
esac
