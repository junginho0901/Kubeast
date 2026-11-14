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

# "<module dir> ./<package dir in it>", one line per package
packages=$(git grep -l "$marker" -- 'services/*_test.go' | while read -r f; do
  dir=$(dirname "$f") mod=$(dirname "$f")
  until [ -f "$mod/go.mod" ]; do mod=$(dirname "$mod"); done
  echo "$mod .${dir#"$mod"}"
done | sort -u)
[ -n "$packages" ] || { echo "no _test.go file under services/ names $marker"; exit 1; }
if [ "${1:-}" = --list ]; then echo "$packages"; exit 0; fi
: "${DBMIGRATE_TEST_DATABASE_URL:?set it to a PostgreSQL server (a superuser or CREATEDB role)}"

log=$(mktemp)
trap 'rm -f "$log"' EXIT
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
echo "$(grep -cE '^\s*--- PASS: TestPostgres' "$log") TestPostgres* passed, $(grep -cE '^\s*--- PASS' "$log") tests passed in all"
exit $fail
