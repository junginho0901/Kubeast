#!/usr/bin/env bash
# `helm upgrade --reuse-values` from each earlier release renders this chart on that release's values.yaml instead
# of its own. Each must either stop at templates/checks/upgrade-values.yaml with the upgrade hint, or render exactly
# what the same values over this chart's defaults render — so nothing this chart added is lost silently.
# Needs the release tags (CI fetches them). Run from anywhere in the checkout.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# secret.yaml makes random passwords and a signing key; existing Secrets leave them out of both renders
args=(--namespace kubeast --set secrets.existingSecret=kubeast-secrets --set auth.signingKey.existingSecret=kubeast-auth-keys)
fail=0
tags=$(git tag -l 'v*' --sort=v:refname)
[ -n "$tags" ] || { echo "no release tags: git fetch --depth=1 origin '+refs/tags/v*:refs/tags/v*'"; exit 1; }
for tag in $tags; do
  git show "$tag:helm/kubeast/values.yaml" > "$work/old.yaml" 2>/dev/null || continue
  rm -rf "$work/chart"
  cp -R helm/kubeast "$work/chart"
  cp "$work/old.yaml" "$work/chart/values.yaml"
  if reuse=$(helm template kubeast "$work/chart" "${args[@]}" 2>&1); then
    if ! reset=$(helm template kubeast helm/kubeast -f "$work/old.yaml" "${args[@]}" 2>&1); then
      echo "$tag: its values do not render over this chart's defaults: $(grep -m1 Error <<<"$reset")"
      fail=1
    elif [ "$reuse" != "$reset" ]; then
      echo "$tag: --reuse-values renders differently from this chart's defaults — add the values path this chart added to templates/checks/upgrade-values.yaml:"
      diff <(echo "$reuse") <(echo "$reset") | head -20
      fail=1
    else
      echo "$tag: renders the same"
    fi
  elif grep -q "come from an earlier Kubeast chart" <<<"$reuse"; then
    echo "$tag: stops with the upgrade hint"
  else
    echo "$tag: $(grep -m1 -A1 Error <<<"$reuse" | tr -s ' \n' ' ') — if it is a values path this chart added, add it to templates/checks/upgrade-values.yaml"
    fail=1
  fi
done
# A values file copied from `helm show values` of a published release holds the image tag and chartVersion the release
# workflow wrote into it (0.7.6 and earlier no chartVersion). Passed with -f to this chart published the same way, it
# must stop with the upgrade hint: it renders, it keeps that release's images.
pub=v99.0.0
rm -rf "$work/pub"
cp -R helm/kubeast "$work/pub"
sed -e "s/^version:.*/version: ${pub#v}/" helm/kubeast/Chart.yaml > "$work/pub/Chart.yaml"
sed -e "s/imageTag:.*/imageTag: \"$pub\"/" -e "s/^chartVersion:.*/chartVersion: \"${pub#v}\"/" helm/kubeast/values.yaml > "$work/pub/values.yaml"
for tag in $tags; do
  git show "$tag:helm/kubeast/values.yaml" 2>/dev/null |
    sed -e "s/imageTag:.*/imageTag: \"$tag\"/" -e "s/^chartVersion:.*/chartVersion: \"${tag#v}\"/" > "$work/copied.yaml" || continue
  if copied=$(helm template kubeast "$work/pub" -f "$work/copied.yaml" "${args[@]}" 2>&1); then
    echo "$tag: a values file copied from it renders over this chart as published, with its images — stop it in templates/checks/upgrade-values.yaml"
    fail=1
  elif grep -q "come from an earlier Kubeast chart" <<<"$copied"; then
    echo "$tag: a values file copied from it stops with the upgrade hint"
  else
    echo "$tag: a values file copied from it: $(grep -m1 -A1 Error <<<"$copied" | tr -s ' \n' ' ')"
    fail=1
  fi
done
exit $fail
