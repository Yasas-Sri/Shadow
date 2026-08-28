#!/usr/bin/env bash
# Register the WRITE-capable Postgres MCP server with the running TrueForge harness.
# Idempotent: PUT /api/v1/settings/mcp-servers is create-or-replace keyed on manifest.name.
# The approval gate lives in the AgentSpec (require_approval_for_tools), not here.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a

TRUEFORGE_URL="${TRUEFORGE_URL:-http://localhost:8790}"
MCP_URL="${MCP_WRITE_PUBLIC_URL:-http://localhost:${MCP_WRITE_PORT:-8001}/mcp}"

curl -fsS -X PUT "${TRUEFORGE_URL}/api/v1/settings/mcp-servers" \
  -H 'Content-Type: application/json' \
  -d "{\"manifest\":{\"type\":\"remote\",\"name\":\"postgres-write\",\"url\":\"${MCP_URL}\",\"description\":\"Write-capable Postgres: apply a shadow-validated migration to production, behind human approval.\"}}"
echo
echo "registered postgres-write MCP -> ${MCP_URL}"
