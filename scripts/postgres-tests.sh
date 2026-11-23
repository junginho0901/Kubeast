#!/usr/bin/env bash
# Runs every Go test that needs a real PostgreSQL server, found instead of listed: those tests read
# DBMIGRATE_TEST_DATABASE_URL and skip themselves when it is unset, so the plain `go test ./...` jobs never run them.
# A package is taken whole when one of its _test.go files names that variable, so a test there that uses the
# database without "Postgres" in its name runs too. CI's dbmigrate (postgres) job runs this.
#   DBMIGRATE_TEST_DATABASE_URL=postgres://... scripts/postgres-tests.sh   (a superuser or CREATEDB role)
#   scripts/postgres-tests.sh --list                                         the module and package of each, no server
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
marker=DBMIGRATE_TEST_DATABASE_URL

files=$(git grep -l "$marker" -- 'services/*_test.go') || [ $? -eq 1 ]
[ -n "$files" ] || { echo "no _test.go file under services/ names $marker"; exit 1; }
# "<module dir> ./<package dir in it>", one line per package
packages=$(while read -r f; do
  dir=$(dirname "$f") mod=$(dirname "$f")
  until [ -f "$mod/go.mod" ] || [ "$mod" = . ]; do mod=$(dirname "$mod"); done
  [ -f "$mod/go.mod" ] || { echo "$f names $marker and no go.mod is above it" >&2; exit 1; }
  echo "$mod .${dir#"$mod"}"
done <<<"$files" | sort -u)
if [ "${1:-}" = --list ]; then echo "$packages"; exit 0; fi
: "${DBMIGRATE_TEST_DATABASE_URL:?set it to a PostgreSQL server (a superuser or CREATEDB role)}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
log=$work/log
fail=0
for mod in $(cut -d' ' -f1 <<<"$packages" | uniq); do
  pkgs=$(awk -v m="$mod" '$1 == m {print $2}' <<<"$packages" | tr '\n' ' ')
  echo "::group::$mod: $pkgs"
  # shellcheck disable=SC2086 # one argument per package
  (cd "$mod" && go test -count=1 -v $pkgs) 2>&1 | tee -a "$log" || fail=1
  echo "::endgroup::"
done
grep -E '^(ok|FAIL|---) ' "$log" | grep -vE '^--- (PASS|SKIP)' || true
# with the variable set, a test skipping for want of a server would be one this job does not reach
if grep -q "needs a PostgreSQL server" "$log"; then
  echo "a test skipped for want of a PostgreSQL server although $marker is set"
  fail=1
fi
# A package whose tests reach the server through a helper outside its _test.go files names no marker and is not run:
# every TestPostgres* under services/ must have passed here.
# one grep thread: with more, git 2.39.5's -o now and then printed a name too short or too long
{ git -c grep.threads=1 grep -hoE '^func TestPostgres[A-Za-z0-9_]*' -- 'services/*_test.go' || [ $? -eq 1 ]; } | sed 's/^func //' | sort > "$work/declared"
sed -n 's/^--- PASS: \(TestPostgres[A-Za-z0-9_]*\) .*/\1/p' "$log" | sort > "$work/passed"
missing=$(comm -23 "$work/declared" "$work/passed")
if [ -n "$missing" ]; then
  echo "TestPostgres* under services/ that did not pass here: $(tr '\n' ' ' <<<"$missing")"
  fail=1
fi
echo "$(grep -c . "$work/passed") of $(grep -c . "$work/declared") TestPostgres* passed, $(grep -cE '^[[:space:]]*--- PASS' "$log") tests passed in all"
exit $fail
