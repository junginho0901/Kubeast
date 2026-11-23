#!/usr/bin/env bash
# Check a published release from outside, read-only: nothing is pushed or signed.
# For each image of the release workflow (both platform variants in the signed index) and for the chart:
#   doc     docs/supply-chain.md's commands as written (provenance, SBOM attestation, cosign signature)
#   strict  the same narrowed to this tag: the release workflow, refs/tags/<tag>, its commit, a GitHub-hosted runner
#   oci     the attestations' copy in the registry (--bundle-from-oci) instead of GitHub's API
# then the SBOMs taken out of their attestations (each must be SPDX 2.3 with packages; the platforms they describe
# are listed), four checks that must be refused (wrong source ref, repository, certificate identity, issuer) and the
# image references of the published chart's default render.
#
#   scripts/verify-release.sh vX.Y.Z               # the tag's commit from this checkout (git fetch --tags first)
#   scripts/verify-release.sh vX.Y.Z <commit>      # a commit, full or short (a short one is resolved in this checkout)
#
# KUBEAST_REPO (default junginho0901/Kubeast) names the repository whose release workflow signed, KUBEAST_REGISTRY
# (default ghcr.io/<its owner in lowercase>) where it pushed. The log (verify.txt) and the SBOMs (gzip) go to
# VERIFY_OUT, default ./verify-release-vX.Y.Z. Needs gh 2.49+ signed in, cosign, crane, helm, jq and git.
# Exit 0 when every check passed, 1 when one failed, 2 on a usage error or a missing tool.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }
case "${1:-}" in -h|--help) usage; exit 0 ;; '') usage >&2; exit 2 ;; esac

TAG=$1
case "$TAG" in v*) ;; *) TAG=v$TAG ;; esac
if ! [[ $TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "not a release tag: $1 (vX.Y.Z)" >&2; exit 2
fi

missing=()
for tool in gh cosign crane helm jq git gzip; do command -v "$tool" >/dev/null || missing+=("$tool"); done
if [ ${#missing[@]} -gt 0 ]; then echo "missing on PATH: ${missing[*]}" >&2; exit 2; fi

# The strict checks compare the full 40-character commit (--source-digest, --certificate-github-workflow-sha).
SRC=${2:-}
if [ -z "$SRC" ]; then
  SRC=$(git -C "$ROOT" rev-parse --verify --quiet "refs/tags/$TAG^{commit}") \
    || { echo "no tag $TAG in this checkout: git fetch --tags, or give the commit as the second argument" >&2; exit 2; }
elif [[ $SRC =~ ^[0-9a-f]{7,40}$ ]]; then
  [ ${#SRC} = 40 ] || SRC=$(git -C "$ROOT" rev-parse --verify --quiet "$SRC^{commit}") \
    || { echo "no commit $2 in this checkout (git fetch first, or give all 40 characters)" >&2; exit 2; }
else
  echo "the second argument must be a commit sha, not '$SRC'" >&2; exit 2
fi

REPO=${KUBEAST_REPO:-junginho0901/Kubeast}
OWNER=$(printf '%s' "${REPO%%/*}" | tr '[:upper:]' '[:lower:]')
REG=${KUBEAST_REGISTRY:-ghcr.io/$OWNER}
DIR=${VERIFY_OUT:-$PWD/verify-release-$TAG}
mkdir -p "$DIR/sbom"
OUT=$DIR/verify.txt
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT
: > "$OUT"

ISS=https://token.actions.githubusercontent.com
ID_RE="^https://github.com/${REPO//./\\.}/\\.github/workflows/release\\.yaml@refs/tags/v"
ID_EXACT="https://github.com/$REPO/.github/workflows/release.yaml@refs/tags/$TAG"
WF=$REPO/.github/workflows/release.yaml
SPDX=https://spdx.dev/Document/v2.3
# The release workflow's images (.github/workflows/release.yaml, the build matrix); ai-service also as <tag>-claude-code.
IMAGES=(auth-service ai-service k8s-service session-service frontend tool-server model-config-controller-go ai-service:claude-code)
# Another repository's name, for the check that a wrong -R is refused.
OTHER_REPO=cli/cli
fail=0

log() { echo "$*" | tee -a "$OUT"; }
lastline() { grep -v '^[[:space:]]*$' "$ERR" | tail -1 | cut -c1-"$1"; }
check() {
  local what=$1 ref=$2; shift 2
  if "$@" >/dev/null 2>"$ERR"; then
    log "PASS $what $ref"
  else
    log "FAIL $what $ref — $(lastline 200)"
    fail=$((fail + 1))
  fi
}
refused() {
  local what=$1 ref=$2; shift 2
  if "$@" >/dev/null 2>"$ERR"; then
    log "FAIL $what $ref — passed but should have been refused"
    fail=$((fail + 1))
  else
    log "PASS $what $ref (refused: $(lastline 120))"
  fi
}

log "# start $(date '+%Y-%m-%d %H:%M:%S %Z') tag=$TAG source=$SRC repo=$REPO registry=$REG"
log "# tools: cosign $(cosign version 2>&1 | awk '/GitVersion/{print $2}') · gh $(gh --version | head -1 | awk '{print $3}') · crane $(crane version) · helm $(helm version --short) · $(jq --version)"
log "# identity (doc): issuer=$ISS regexp=$ID_RE"
log "# identity (strict): $ID_EXACT · workflow sha $SRC · trigger push · gh --signer-workflow $WF --source-ref refs/tags/$TAG --source-digest $SRC --deny-self-hosted-runners"

for img in "${IMAGES[@]}"; do
  name=${img%%:*}
  tag=$TAG; [ "$img" != "$name" ] && tag=$TAG-${img#*:}
  ref=$REG/kubeast-$name:$tag
  log ""
  log "## $ref"
  idx=$(crane digest "$ref" 2>/dev/null)
  if [ -z "$idx" ]; then log "FAIL digest $ref — tag not found"; fail=$((fail + 1)); continue; fi
  manifest=$(crane manifest "$ref")
  plats=$(jq -r '[.manifests[] | select(.platform.os=="linux") | "\(.platform.os)/\(.platform.architecture)=\(.digest[7:19])"] | join(" ")' <<<"$manifest")
  extra=$(jq -r '[.manifests[] | select(.platform.os!="linux") | .annotations["vnd.docker.reference.type"] // "other"] | group_by(.) | map("\(.[0])×\(length)") | join(" ")' <<<"$manifest")
  log "index $idx · $plats · non-platform entries: ${extra:-none}"
  case "$plats" in
    *linux/amd64=*linux/arm64=*|*linux/arm64=*linux/amd64=*) log "PASS platforms $ref (amd64 + arm64 in the signed index)" ;;
    *) log "FAIL platforms $ref — $plats"; fail=$((fail + 1)) ;;
  esac
  check "provenance(doc)" "$ref" gh attestation verify "oci://$ref" -R "$REPO"
  check "provenance(strict)" "$ref" gh attestation verify "oci://$ref" -R "$REPO" --signer-workflow "$WF" --source-ref "refs/tags/$TAG" --source-digest "$SRC" --deny-self-hosted-runners
  check "provenance(oci)" "$ref" gh attestation verify "oci://$ref" -R "$REPO" --bundle-from-oci
  check "sbom(doc)" "$ref" gh attestation verify "oci://$ref" -R "$REPO" --predicate-type "$SPDX"
  check "sbom(oci)" "$ref" gh attestation verify "oci://$ref" -R "$REPO" --predicate-type "$SPDX" --bundle-from-oci
  # the SBOMs themselves, as the doc takes one out (.verificationResult.statement.predicate), each one kept
  base=$DIR/sbom/$name${tag#"$TAG"}
  rm -f "$base".*spdx.json "$base".*spdx.json.gz
  if gh attestation verify "oci://$ref" -R "$REPO" --predicate-type "$SPDX" --format json 2>"$ERR" > "$base.all.json"; then
    count=$(jq 'length' "$base.all.json")
    arches=()
    for ((i = 0; i < count; i++)); do
      f=$base.$i.spdx.json
      jq ".[$i].verificationResult.statement.predicate" "$base.all.json" > "$f"
      if jq -e '.spdxVersion == "SPDX-2.3" and (.packages | length) > 0' "$f" >/dev/null 2>&1; then
        arch=$(jq -r '[.packages[].externalRefs[]?.referenceLocator | select(startswith("pkg:oci/")) | capture("arch=(?<a>[a-z0-9]+)").a] | unique | join(",")' "$f")
        arches+=("${arch:-?}")
        log "PASS sbom-open $ref #$i — $(jq -r '"\(.spdxVersion) · packages \(.packages|length) · files \((.files//[])|length) · \(.creationInfo.creators|map(select(startswith("Tool")))|join(",")) · created \(.creationInfo.created)"' "$f") · describes ${arch:-?} · $(wc -c < "$f" | tr -d ' ') bytes · sha256 $(shasum -a 256 "$f" | cut -c1-16)"
        gzip -f "$f"
      else
        log "FAIL sbom-open $ref #$i — predicate missing or not SPDX-2.3"; fail=$((fail + 1))
      fi
    done
    [ "$count" -gt 0 ] || { log "FAIL sbom-open $ref — no SBOM attestation"; fail=$((fail + 1)); }
    log "INFO sbom platforms $ref — ${arches[*]:-none}"
  else
    log "FAIL sbom-open $ref — $(lastline 200)"; fail=$((fail + 1))
  fi
  rm -f "$base.all.json"
  check "cosign(doc)" "$ref" cosign verify --certificate-oidc-issuer "$ISS" --certificate-identity-regexp "$ID_RE" "$ref"
  check "cosign(strict)" "$REG/kubeast-$name@$idx" cosign verify --certificate-oidc-issuer "$ISS" --certificate-identity "$ID_EXACT" --certificate-github-workflow-sha "$SRC" --certificate-github-workflow-trigger push "$REG/kubeast-$name@$idx"
  # A platform variant has no signature of its own: the signature is on the index, which names both by digest.
  for arch in amd64 arm64; do
    d=$(jq -r --arg a "$arch" '.manifests[] | select(.platform.os=="linux" and .platform.architecture==$a) | .digest' <<<"$manifest")
    [ -n "$d" ] || continue
    if cosign verify --certificate-oidc-issuer "$ISS" --certificate-identity-regexp "$ID_RE" "$REG/kubeast-$name@$d" >/dev/null 2>&1; then
      log "INFO cosign $arch variant ${d:7:12} signed"
    else
      log "INFO cosign $arch variant ${d:7:12} no signature of its own (signed through the index)"
    fi
  done
done

chart=$REG/charts/kubeast:${TAG#v}
log ""
log "## $chart"
cidx=$(crane digest "$chart" 2>/dev/null)
if [ -z "$cidx" ]; then
  log "FAIL digest $chart — tag not found"; fail=$((fail + 1))
else
  log "digest $cidx · $(helm show chart "oci://$REG/charts/kubeast" --version "${TAG#v}" 2>/dev/null | grep -E '^(name|version|appVersion):' | tr '\n' ' ')"
  check "provenance(doc)" "$chart" gh attestation verify "oci://$chart" -R "$REPO"
  check "provenance(strict)" "$chart" gh attestation verify "oci://$chart" -R "$REPO" --signer-workflow "$WF" --source-ref "refs/tags/$TAG" --source-digest "$SRC" --deny-self-hosted-runners
  check "provenance(oci)" "$chart" gh attestation verify "oci://$chart" -R "$REPO" --bundle-from-oci
  check "cosign(doc)" "$chart" cosign verify --certificate-oidc-issuer "$ISS" --certificate-identity-regexp "$ID_RE" "$chart"
  check "cosign(strict)" "$REG/charts/kubeast@$cidx" cosign verify --certificate-oidc-issuer "$ISS" --certificate-identity "$ID_EXACT" --certificate-github-workflow-sha "$SRC" --certificate-github-workflow-trigger push "$REG/charts/kubeast@$cidx"
fi

# The same commands refuse a wrong ref, repository, identity and issuer: they do not pass whatever they are given.
log ""
log "## checks that must be refused"
neg=$REG/kubeast-auth-service:$TAG
refused "provenance wrong --source-ref" "$neg" gh attestation verify "oci://$neg" -R "$REPO" --source-ref refs/tags/v0.0.0
refused "provenance wrong -R" "$neg" gh attestation verify "oci://$neg" -R "$OTHER_REPO"
refused "cosign wrong identity" "$neg" cosign verify --certificate-oidc-issuer "$ISS" --certificate-identity "https://github.com/$REPO/.github/workflows/release.yaml@refs/tags/v0.0.0" "$neg"
refused "cosign wrong issuer" "$neg" cosign verify --certificate-oidc-issuer https://accounts.google.com --certificate-identity-regexp "$ID_RE" "$neg"

# The published chart's default render: which image references are pinned by digest (reported, not a check).
log ""
log "## chart default render: image references"
img_lines=$(helm template kubeast "oci://$REG/charts/kubeast" --version "${TAG#v}" 2>"$ERR" | grep -E '^[[:space:]]*image:' | sed -E 's/^[[:space:]]*image:[[:space:]]*//; s/"//g' | sort | uniq -c)
if [ -z "$img_lines" ]; then
  log "FAIL chart render — $(lastline 200)"; fail=$((fail + 1))
else
  log "image: lines $(awk '{s+=$1} END {print s+0}' <<<"$img_lines") · distinct $(wc -l <<<"$img_lines" | tr -d ' ') · with @sha256 $(grep -c '@sha256:' <<<"$img_lines")"
  sed 's/^/  /' <<<"$img_lines" | tee -a "$OUT"
fi

log ""
log "# end $(date '+%H:%M:%S') fail=$fail · log $OUT · SBOMs $DIR/sbom"
[ "$fail" -eq 0 ]
