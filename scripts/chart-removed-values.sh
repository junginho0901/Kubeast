#!/usr/bin/env bash
# A values path the latest release's values.yaml has and this chart's has not must stop at
# templates/checks/removed-values.yaml, or a user who set it loses that value without a word. Each such path is set to
# the release's value and the render must stop there. The check is also tried on a copy listing a path the defaults
# set, so it is known to stop while its list is empty. Needs the release tags (CI fetches them). Run from anywhere in
# the checkout.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
check=helm/kubeast/templates/checks/removed-values.yaml
stop="is no longer a Kubeast value"
# secret.yaml makes random passwords and a signing key; existing Secrets leave them out
args=(--namespace kubeast --set secrets.existingSecret=kubeast-secrets --set auth.signingKey.existingSecret=kubeast-auth-keys)
tag=$(git tag -l 'v*' --sort=-v:refname | grep -m1 -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)
[ -n "$tag" ] || { echo "no release tags: git fetch --depth=1 origin '+refs/tags/v*:refs/tags/v*'"; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail=0

cp -R helm/kubeast "$work/chart"
# shellcheck disable=SC2016 # the template's own $removed
sed -i.orig 's/^{{- $removed := dict/& "global.imageTag" "self-check"/' "$work/chart/templates/checks/removed-values.yaml"
if ! grep -q '"self-check"' "$work/chart/templates/checks/removed-values.yaml"; then
  echo "$check: no line '{{- \$removed := dict' to try the check with"
  fail=1
elif out=$(helm template kubeast "$work/chart" "${args[@]}" 2>&1) || ! grep -q "global.imageTag $stop" <<<"$out"; then
  echo "$check: a listed path the values set does not stop the render: $(grep -m1 Error <<<"$out")"
  fail=1
fi

git show "$tag:helm/kubeast/values.yaml" > "$work/old.yaml"
scripts/values-paths.sh --json "$work/old.yaml" > "$work/old.json"
scripts/values-paths.sh "$work/old.yaml" | sort > "$work/old"
scripts/values-paths.sh helm/kubeast/values.yaml | sort > "$work/new"
gone=$(comm -23 "$work/old" "$work/new")
for p in $gone; do
  value=$(jq -c --arg p "$p" 'getpath($p | split("."))' "$work/old.json")
  # a map with keys is tried through the paths under it
  jq -e 'type == "object" and length > 0' <<<"$value" >/dev/null && continue
  # null set there reads as not set; any value stands in for it
  [ "$value" != null ] || value='"stand-in"'
  if out=$(helm template kubeast helm/kubeast "${args[@]}" --set-json "$p=$value" 2>&1); then
    echo "$tag has $p and this chart does not: a value set there is dropped without a word. Add it to $check with what to set instead."
    fail=1
  elif grep -q "$stop" <<<"$out"; then
    echo "$tag has $p: stops at $check"
  else
    echo "$tag has $p: $(grep -m1 -A1 Error <<<"$out" | tr -s ' \n' ' ')"
    fail=1
  fi
done
[ -n "$gone" ] || echo "$tag: every values path it has is in values.yaml"
exit $fail
