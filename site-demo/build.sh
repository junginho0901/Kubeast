#!/usr/bin/env bash
# Builds the project site's demo (site/demo/) from the v0.8.0 console, unchanged, and the sample layer in site-demo/.
#
#   site-demo/build.sh                                        # npm ci of v0.8.0's own lock, then the build
#   KUBEAST_DEMO_NODE_MODULES=<dir> site-demo/build.sh        # use an installed node_modules instead of npm ci
#   KUBEAST_DEMO_BASE=/site/demo/ site-demo/build.sh          # another path than /Kubeast/demo/ (a local preview)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HERE="$ROOT/site-demo"
RELEASE="$HERE/.release"
COMMIT=b4e4ff9f9c592e6ccf909ead68f8cdf87c360786   # v0.7.9

# The console's source at v0.8.0 (a shallow clone fetches that one commit).
if [ ! -f "$RELEASE/SOURCE" ] || [ "$(cat "$RELEASE/SOURCE")" != "$COMMIT" ]; then
  if ! git -C "$ROOT" -c gc.auto=0 cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
    git -C "$ROOT" -c gc.auto=0 fetch --no-tags --depth 1 origin "$COMMIT"
  fi
  rm -rf "$RELEASE"
  mkdir -p "$RELEASE"
  git -C "$ROOT" -c gc.auto=0 archive "$COMMIT" frontend | tar -x -C "$RELEASE"
  echo "$COMMIT" > "$RELEASE/SOURCE"
fi

# Its dependencies.
if [ ! -e "$RELEASE/frontend/node_modules" ]; then
  if [ -n "${KUBEAST_DEMO_NODE_MODULES:-}" ]; then
    ln -s "$KUBEAST_DEMO_NODE_MODULES" "$RELEASE/frontend/node_modules"
  else
    (cd "$RELEASE/frontend" && npm ci --no-audit --no-fund)
  fi
fi
# The demo's own imports (react, axios, …) resolve to the same packages as the console's.
ln -sfn "$RELEASE/frontend/node_modules" "$HERE/node_modules"

node "$HERE/build.mjs"
