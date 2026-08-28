#!/usr/bin/env bash
# Register the read-only Postgres MCP server with the running TrueForge harness.
# Idempotent: PUT /api/v1/mcp-servers is create-or-replace keyed on manifest.name.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a

TRUEFORGE_URL="${TRUEFORGE_URL:-http://localhost:8790}"
MCP_URL="${MCP_PUBLIC_URL:-http://localhost:${MCP_PORT:-8000}/mcp}"

curl -fsS -X PUT "${TRUEFORGE_URL}/api/v1/settings/mcp-servers" \
  -H 'Content-Type: application/json' \
  -d "{\"manifest\":{\"type\":\"remote\",\"name\":\"postgres\",\"url\":\"${MCP_URL}\",\"description\":\"Read-only Postgres schema introspection and queries for SHADOW.\"}}"
echo
echo "registered postgres MCP -> ${MCP_URL}"
