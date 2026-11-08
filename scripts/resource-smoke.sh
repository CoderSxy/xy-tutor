#!/bin/sh
set -eu
# Read-only; run during two chats plus one queued parsing task.
: "${APP_ORIGIN:?Set APP_ORIGIN}"
df -P .
if command -v docker >/dev/null 2>&1; then
  docker compose --env-file .env -f infra/compose.prod.yaml stats --no-stream
fi
curl --fail --silent --show-error "$APP_ORIGIN/api/health/ready"
printf '\n'
