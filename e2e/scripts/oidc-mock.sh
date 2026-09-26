#!/usr/bin/env bash
# Point the kind cluster's auth-service at a local mock OpenID Connect provider
# so oidc-login.spec.ts can exercise the whole sign-in flow in a browser.
#
#   e2e/scripts/oidc-mock.sh up      # start mock-oauth2-server on :8080, enable OIDC on auth-service
#   e2e/scripts/oidc-mock.sh down    # remove the env again, stop the container
#
# The provider runs as a Docker container on the host. auth-service (in kind)
# reaches it as host.docker.internal:8080; the browser must resolve that name
# to 127.0.0.1 (the spec launches Chromium with --host-resolver-rules) so the
# issuer is the same string on both sides.
set -euo pipefail

NS="${KUBEAST_NAMESPACE:-kubeast}"
MOCK_IMAGE="ghcr.io/navikt/mock-oauth2-server:6.0.3"
MOCK_NAME="kubeast-oidc-mock"
ISSUER="http://host.docker.internal:8080/default"
BASE_URL="${E2E_BASE_URL:-http://localhost:30080}"

case "${1:-}" in
  up)
    docker rm -f "$MOCK_NAME" >/dev/null 2>&1 || true
    docker run -d --name "$MOCK_NAME" -p 8080:8080 \
      -e JSON_CONFIG='{"interactiveLogin":true}' "$MOCK_IMAGE" >/dev/null
    for _ in $(seq 1 30); do
      curl -fs "http://localhost:8080/default/.well-known/openid-configuration" >/dev/null && break
      sleep 1
    done
    kubectl -n "$NS" set env deployment/auth-service \
      OIDC_ENABLED=true \
      OIDC_ISSUER_URL="$ISSUER" \
      OIDC_CLIENT_ID=kubeast \
      OIDC_CLIENT_SECRET=e2e-mock-secret \
      OIDC_REDIRECT_URL="$BASE_URL/api/v1/auth/oidc/callback" \
      OIDC_DISPLAY_NAME="Mock IdP" \
      OIDC_ALLOWED_DOMAINS=example.com \
      OIDC_ROLE_MAPPING="kubeast-admins=Admin,kubeast-users=Member"
    kubectl -n "$NS" rollout status deployment/auth-service --timeout=120s
    ;;
  down)
    kubectl -n "$NS" set env deployment/auth-service \
      OIDC_ENABLED- OIDC_ISSUER_URL- OIDC_CLIENT_ID- OIDC_CLIENT_SECRET- OIDC_REDIRECT_URL- \
      OIDC_DISPLAY_NAME- OIDC_ALLOWED_DOMAINS- OIDC_ROLE_MAPPING-
    kubectl -n "$NS" rollout status deployment/auth-service --timeout=120s
    docker rm -f "$MOCK_NAME" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
