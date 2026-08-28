#!/usr/bin/env bash
# Register the Anthropic model provider (claude-opus-4-8) with the running harness.
# Idempotent: PUT /api/v1/settings/model-providers is create-or-replace keyed on type.
# The provider manifest must carry the model entry (registration doesn't merge the shipped
# catalog), so we send claude-opus-4-8 with the reasoning efforts the AgentSpec uses.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

TRUEFORGE_URL="${TRUEFORGE_URL:-http://localhost:8790}"
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY in .env (your Anthropic API key)}"

curl -fsS -X PUT "${TRUEFORGE_URL}/api/v1/settings/model-providers" \
  -H 'Content-Type: application/json' \
  -d "{\"manifest\":{\"type\":\"anthropic\",\"auth\":{\"api_key\":\"${ANTHROPIC_API_KEY}\"},\"models\":[{\"model_id\":\"claude-opus-4-8\",\"name\":\"claude-opus-4-8\",\"properties\":{\"context_length\":1000000,\"max_output_tokens\":128000,\"reasoning_efforts\":[\"low\",\"medium\",\"high\",\"xhigh\",\"max\"]}}]}}"
echo
echo "registered anthropic model provider -> claude-opus-4-8"
