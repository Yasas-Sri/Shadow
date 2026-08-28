#!/usr/bin/env bash
# Register the Daytona sandbox provider with the running TrueForge harness.
# Needs a Daytona API key (free at daytona.io) in DAYTONA_API_KEY. The sandbox is
# required for the shadow dry-run AND for skills to load. Idempotent create-or-replace.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

TRUEFORGE_URL="${TRUEFORGE_URL:-http://localhost:8790}"
: "${DAYTONA_API_KEY:?set DAYTONA_API_KEY in .env (get one free at https://daytona.io)}"

curl -fsS -X PUT "${TRUEFORGE_URL}/api/v1/settings/sandbox-providers" \
  -H 'Content-Type: application/json' \
  -d "{\"manifest\":{\"type\":\"daytona\",\"auth\":{\"api_key\":\"${DAYTONA_API_KEY}\"},\"exec_timeout_ms\":60000,\"auto_stop_interval_in_minutes\":5,\"auto_archive_interval_in_minutes\":60,\"auto_delete_interval_in_minutes\":7200}}"
echo
echo "registered daytona sandbox provider. Image build may take a minute -- check:"
echo "  curl -s ${TRUEFORGE_URL}/api/v1/capabilities | grep -o '\"sandbox\":{[^}]*}'"
