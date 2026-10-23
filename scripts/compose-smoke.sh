#!/usr/bin/env bash
# Start the Docker Compose install with install-docker.sh, sign in, check that no container restarted, then
# remove it. The release workflow runs it on the images of the run before any of them gets the release tag.
# It runs in a temporary copy (Compose project kubeast-smoke), so a checkout's .env is left alone.
#
#   scripts/compose-smoke.sh                 # the images docker-compose.yml names (KUBEAST_TAG)
#   scripts/compose-smoke.sh <digests-dir>   # one file per image, named after it: "<image>@<digest> [suffix]"
#   scripts/compose-smoke.sh --build         # build the images from this checkout first
#
# SMOKE_PORT sets the gateway port (default 8000).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICES=(auth-service ai-service k8s-service session-service tool-server frontend)
PORT="${SMOKE_PORT:-8000}"
WORK="$(mktemp -d)"
export COMPOSE_PROJECT_NAME=kubeast-smoke
built=false
made_env=false

cleanup() {
  (cd "$WORK" && docker compose down -v --remove-orphans >/dev/null 2>&1) || true
  if $built; then
    for s in "${SERVICES[@]}"; do docker rmi "ghcr.io/junginho0901/kubeast-$s:smoke" >/dev/null 2>&1 || true; done
  fi
  if $made_env; then rm -f "$ROOT/.env"; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/helm/kubeast/files"
cp "$ROOT/docker-compose.yml" "$ROOT/install-docker.sh" "$WORK/"
cp "$ROOT/helm/kubeast/files/nginx.conf" "$WORK/helm/kubeast/files/"

case "${1:-}" in
  "") ;;
  --build)
    export KUBEAST_TAG=smoke
    built=true
    # Compose refuses to read docker-compose.yml without the .env its services name.
    [[ -f "$ROOT/.env" ]] || { : > "$ROOT/.env"; made_env=true; }
    docker compose -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.build.yml" build "${SERVICES[@]}"
    ;;
  *)
    {
      echo "services:"
      for s in "${SERVICES[@]}"; do
        read -r ref _ < "$1/$s"
        printf '  %s:\n    image: %s\n' "$s" "$ref"
      done
    } > "$WORK/docker-compose.smoke.yml"
    export COMPOSE_FILE=docker-compose.yml:docker-compose.smoke.yml
    ;;
esac

cd "$WORK"
show_logs() { docker compose ps -a; docker compose logs --no-color --tail 60; }
./install-docker.sh --port "$PORT" > install.log 2>&1 || { sed -e '/Password:/d' install.log; show_logs; exit 1; }

# Sign in as the admin the installer created (the password stays in .env, never printed).
password=$(grep '^DEFAULT_ADMIN_PASSWORD=' .env | cut -d= -f2-)
body=$(printf '{"email":"admin","password":"%s"}' "$password")
curl -sf -X POST "http://localhost:${PORT}/api/v1/auth/login" -H 'Content-Type: application/json' --data-raw "$body" \
  | grep -q '"access_token"' || { echo "::error::admin sign-in failed"; show_logs; exit 1; }
echo "signed in"

# A service that crashes after start shows as a restart within a few seconds.
sleep 20
bad=0
for s in "${SERVICES[@]}" postgres redis gateway; do
  id=$(docker compose ps -q "$s")
  read -r state restarts < <(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$id")
  echo "$s: $state, restarts $restarts"
  [[ "$state" == running && "$restarts" == 0 ]] || bad=1
done
init=$(docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -aq volume-init)")
echo "volume-init: exit $init"
[[ "$init" == 0 && $bad == 0 ]] || { echo "::error::a container is not running or restarted"; show_logs; exit 1; }
echo "compose install OK"
