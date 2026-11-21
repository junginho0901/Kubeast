#!/usr/bin/env bash
# CI check (the gofmt job): the Go minor every Dockerfile builds with (FROM ... golang:X.Y...) is the go-version of
# every setup-go in .github/workflows/ci.yaml, so CI tests with the images' Go. dependabot's base-images PR moves the
# Dockerfiles alone; this fails it, naming each line to change, until the same pull request moves ci.yaml too.
# The go.mod `go` lines are minimums and are not read here (1.26.x; services/tool-server/kubectl has 1.27).
# Usage: scripts/check-go-version.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
workflow=.github/workflows/ci.yaml
from_re='^FROM[[:space:]]+(--[^[:space:]]+[[:space:]]+)*golang:'
minor_re="${from_re}"'([0-9]+\.[0-9]+)([^0-9].*)?$'

dockerfiles=$(git grep -lE "${from_re}" -- '*Dockerfile*') || [ "${?}" -eq 1 ]
[ -n "${dockerfiles}" ] || { echo "no Dockerfile builds FROM golang:" >&2; exit 1; }

want=""
failed=0
while IFS= read -r file; do
  while IFS= read -r hit; do
    line=${hit%%:*}
    minor=$(printf '%s\n' "${hit#*:}" | sed -nE "s/${minor_re}/\\2/p")
    if [ -z "${minor}" ]; then
      echo "${file}:${line}: a golang tag without its Go minor (golang:X.Y...)" >&2
      failed=1
      continue
    fi
    [ -n "${want}" ] || want=${minor}
    if [ "${minor}" != "${want}" ]; then
      echo "${file}:${line}: golang:${minor}, where another Dockerfile has golang:${want}" >&2
      failed=1
    fi
  done <<<"$(grep -nE "${from_re}" "${file}")"
done <<<"${dockerfiles}"
[ -n "${want}" ] || exit 1

setups=0
while IFS= read -r hit; do
  [ -n "${hit}" ] || continue
  line=${hit%%:*}
  text=${hit#*:}
  value=$(printf '%s\n' "${text}" | sed -E 's/^[[:space:]]*go-version(-file)?:[[:space:]]*//; s/[[:space:]]+#.*$//' | tr -d "\"'")
  case "${text}" in
    *go-version-file:*)
      echo "${workflow}:${line}: go-version-file reads a go.mod's minimum; the images build with go-version \"${want}\"" >&2
      failed=1
      ;;
    *)
      # The gofmt job formats with the newest Go on purpose.
      if [ "${value}" = stable ]; then
        continue
      fi
      if [ "${value}" != "${want}" ]; then
        echo "${workflow}:${line}: go-version \"${value}\", where the Dockerfiles build with golang:${want}" >&2
        failed=1
      else
        setups=$((setups + 1))
      fi
      ;;
  esac
done <<<"$(grep -nE '^[[:space:]]*go-version(-file)?:' "${workflow}" || true)"

if [ "${failed}" -eq 0 ] && [ "${setups}" -eq 0 ]; then
  echo "${workflow}: no setup-go step with go-version \"${want}\"" >&2
  failed=1
fi
if [ "${failed}" -ne 0 ]; then
  echo "Move every FROM golang:X.Y of the Dockerfiles and every go-version of ${workflow} in one pull request." >&2
  exit 1
fi
echo "Dockerfiles golang:${want}; ${workflow} go-version \"${want}\" in ${setups} setup-go steps"
