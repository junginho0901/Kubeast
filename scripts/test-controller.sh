#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/services/model-config-controller-go"

if command -v go >/dev/null 2>&1; then
  go test ./internal/controller -v
  exit 0
fi

if command -v docker >/dev/null 2>&1; then
  docker run --rm -v "$PWD":/app -w /app golang:1.21 go test ./internal/controller -v
  exit 0
fi

echo "Error: go 또는 docker가 필요합니다." >&2
exit 1
