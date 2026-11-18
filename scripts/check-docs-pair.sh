#!/usr/bin/env bash
# Pull request check (CI): docs/X.md and docs/ko/X.md change together, as do README.md and README.ko.md, and every
# values path the pull request adds to helm/kubeast/values.yaml is named in docs/configuration.md and
# docs/ko/configuration.md (in a yaml block, or written out as a.b.c). A change of spaces or blank lines only does
# not count. When one side is left as it is on purpose, a commit of the pull request says why in a trailer, in the last
# paragraph of its message with the other trailers (Co-Authored-By). Files or values paths named after the kind limit
# it to those; naming none, it covers the pull request:
#   Docs-Pair: en-only [<file>...] <reason>               (or ko-only)
#   Docs-Pair: values-not-in-docs [<path>...] <reason>
# Usage: scripts/check-docs-pair.sh <base> [<head>]   (the pull request's base and head commits; head defaults to HEAD)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
[ $# -ge 1 ] || { echo "usage: $0 <base> [<head>]" >&2; exit 2; }
head=$(git rev-parse "${2:-HEAD}")
base=$(git merge-base "$1" "$head")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git log --format='%(trailers:key=Docs-Pair,valueonly,unfold)' "$base..$head" > "$work/trailers"
where="in a commit trailer, in the last paragraph of the message with Co-Authored-By and no blank line between"
# waived KIND NAME NAMES: a trailer of KIND with a reason names NAME, or names nothing listed in the file NAMES
waived() {
  awk -v kind="$1" -v name="$2" '
    FILENAME == ARGV[1] { listed[$0] = 1; next }
    tolower($1) == kind {
      n = 0; hit = 0
      for (i = 2; i <= NF && ($i in listed); i++) { n++; if ($i == name) hit = 1 }
      if (i <= NF && (n == 0 || hit)) found = 1
    }
    END { exit !found }' "$3" "$work/trailers"
}
# a move shows as the old name gone and the new one added; names are written as they are, not quoted
changed=$(git -c core.quotePath=false diff --no-renames --name-only "$base" "$head")
echo "$changed" > "$work/changed"
fail=0

while IFS= read -r f <&3; do
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
  if waived "$side-only" "$f" "$work/changed"; then
    echo "$f changed without $twin (Docs-Pair: $side-only)"
  else
    echo "::error file=$f::$f changed without $twin. Change both, or say why $where: Docs-Pair: $side-only [$f] <reason>"
    fail=1
  fi
done 3<<<"$changed"

values=helm/kubeast/values.yaml
if grep -qxF "$values" <<<"$changed"; then
  git show "$base:$values" > "$work/old.yaml"
  git show "$head:$values" > "$work/new.yaml"
  scripts/values-paths.sh "$work/old.yaml" | sort > "$work/old"
  scripts/values-paths.sh --leaves "$work/new.yaml" | sort > "$work/new"
  comm -13 "$work/old" "$work/new" > "$work/added"
  for doc in docs/configuration.md docs/ko/configuration.md; do
    git show "$head:$doc" > "$work/doc.md"
    # each yaml block read by itself: two of them with the same top-level key do not merge
    rm -f "$work"/block.*
    awk -v out="$work/block." '/^```yaml/ {y = 1; n++; next} /^```/ {y = 0} y {print > (out n)}' "$work/doc.md"
    : > "$work/doc"
    for b in "$work"/block.*; do
      [ -e "$b" ] || continue
      scripts/values-paths.sh "$b" >> "$work/doc" 2> "$work/err" ||
        echo "::warning file=$doc::yaml block ${b##*.} of $doc does not read as values, so it names no path: $(grep -m1 . "$work/err" | sed "s|$work/||")"
    done
    : > "$work/named"
    while IFS= read -r p; do
      if grep -qxF "$p" "$work/doc"; then
        echo "$p" >> "$work/named"
      # written out as a.b.c, not followed by more of a name (a full stop may end the sentence)
      elif [[ $p == *.* ]] && grep -qE "(^|[^A-Za-z0-9_.])${p//./\\.}\.?([^A-Za-z0-9_.]|$)" "$work/doc.md"; then
        echo "$p" >> "$work/named"
      fi
    done < "$work/added"
    # A block repeated per service and added together (autoscaling.<service>.enabled) may be shown once: a path is
    # named when one added beside it, differing in one key that is neither the first nor the last, is.
    unnamed=$(awk 'function shapes(p,   n, i, s, t, out) { n = split(p, s, "."); out = ""
        for (i = 2; i < n; i++) { t = s[i]; s[i] = "*"; out = out " " join(s, n); s[i] = t } return out }
      function join(s, n,   i, r) { r = s[1]; for (i = 2; i <= n; i++) r = r "." s[i]; return r }
      FILENAME == ARGV[1] { named[$0] = 1; m = split(shapes($0), sh, " "); for (j = 1; j <= m; j++) seen[sh[j]] = 1; next }
      NF && !($0 in named) { m = split(shapes($0), sh, " "); ok = 0; for (j = 1; j <= m; j++) if (sh[j] in seen) ok = 1; if (!ok) print }' \
      "$work/named" "$work/added")
    for p in $unnamed; do
      if waived values-not-in-docs "$p" "$work/added"; then
        echo "$p is not in $doc (Docs-Pair: values-not-in-docs)"
      else
        echo "::error file=$doc::$values adds $p, which $doc does not name. Add it to a yaml block or write it out, or say why $where: Docs-Pair: values-not-in-docs [$p] <reason>"
        fail=1
      fi
    done
  done
fi
exit $fail
