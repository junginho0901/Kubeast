#!/usr/bin/env bash
# Pull request check (CI): docs/X.md and docs/ko/X.md change together, as do README.md and README.ko.md, and every
# values path the pull request adds to helm/kubeast/values.yaml is named in docs/configuration.md and
# docs/ko/configuration.md (in their yaml block, or written out as a.b.c). A change of spaces or blank lines only does
# not count. When one side is left as it is on purpose, a commit of the pull request says why in a trailer:
#   Docs-Pair: en-only <reason>               (or ko-only)
#   Docs-Pair: values-not-in-docs <reason>
# Usage: scripts/check-docs-pair.sh <base> [<head>]   (the pull request's base and head commits; head defaults to HEAD)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[ $# -ge 1 ] || { echo "usage: $0 <base> [<head>]" >&2; exit 2; }
head=$(git rev-parse "${2:-HEAD}")
base=$(git merge-base "$1" "$head")
trailers=$(git log --format='%(trailers:key=Docs-Pair,valueonly)' "$base..$head")
waived() { grep -qiE "^$1[[:space:]]+[^[:space:]]" <<<"$trailers"; }
changed=$(git diff --name-only "$base" "$head")
fail=0

for f in $changed; do
  case $f in
    docs/ko/*.md) twin=docs/${f#docs/ko/} side=ko ;;
    docs/*/*) continue ;;
    docs/*.md) twin=docs/ko/${f#docs/} side=en ;;
    README.md) twin=README.ko.md side=en ;;
    README.ko.md) twin=README.md side=ko ;;
    *) continue ;;
  esac
  grep -qxF "$twin" <<<"$changed" && continue
  git diff --quiet -w --ignore-blank-lines "$base" "$head" -- "$f" && continue
  if waived "$side-only"; then
    echo "$f changed without $twin (Docs-Pair: $side-only)"
  else
    echo "::error file=$f::$f changed without $twin. Change both, or say why in a commit trailer: Docs-Pair: $side-only <reason>"
    fail=1
  fi
done

values=helm/kubeast/values.yaml
if grep -qxF "$values" <<<"$changed"; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  git show "$base:$values" > "$work/old.yaml"
  git show "$head:$values" > "$work/new.yaml"
  scripts/values-paths.sh "$work/old.yaml" | sort > "$work/old"
  scripts/values-paths.sh --leaves "$work/new.yaml" | sort > "$work/new"
  added=$(comm -13 "$work/old" "$work/new")
  for doc in docs/configuration.md docs/ko/configuration.md; do
    git show "$head:$doc" > "$work/doc.md"
    awk '/^```yaml/ {y = 1; next} /^```/ {y = 0} y' "$work/doc.md" > "$work/doc.yaml"
    scripts/values-paths.sh "$work/doc.yaml" > "$work/doc" 2>/dev/null || : > "$work/doc"
    : > "$work/named"
    for p in $added; do
      grep -qxF "$p" "$work/doc" && { echo "$p" >> "$work/named"; continue; }
      # written out as a.b.c, not followed by more of a name
      [[ $p == *.* ]] && grep -qE "(^|[^A-Za-z0-9_.])${p//./\\.}([^A-Za-z0-9_]|$)" "$work/doc.md" && echo "$p" >> "$work/named"
    done
    # A block repeated per service and added together (autoscaling.<service>.enabled) may be shown once: a path is
    # named when one added beside it, differing in one key that is not the last, is.
    echo "$added" > "$work/added"
    unnamed=$(awk 'function shapes(p,   n, i, s, t, out) { n = split(p, s, "."); out = ""
        for (i = 1; i < n; i++) { t = s[i]; s[i] = "*"; out = out " " join(s, n); s[i] = t } return out }
      function join(s, n,   i, r) { r = s[1]; for (i = 2; i <= n; i++) r = r "." s[i]; return r }
      FILENAME == ARGV[1] { named[$0] = 1; m = split(shapes($0), sh, " "); for (j = 1; j <= m; j++) seen[sh[j]] = 1; next }
      NF && !($0 in named) { m = split(shapes($0), sh, " "); ok = 0; for (j = 1; j <= m; j++) if (sh[j] in seen) ok = 1; if (!ok) print }' \
      "$work/named" "$work/added")
    for p in $unnamed; do
      if waived values-not-in-docs; then
        echo "$p is not in $doc (Docs-Pair: values-not-in-docs)"
      else
        echo "::error file=$doc::$values adds $p, which $doc does not name. Add it to its yaml block or write it out, or say why in a commit trailer: Docs-Pair: values-not-in-docs <reason>"
        fail=1
      fi
    done
  done
fi
exit $fail
