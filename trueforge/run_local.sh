#!/usr/bin/env bash
# One command to bring the whole SHADOW stack up locally and register everything, then leave
# it running so you can open a session and watch the approval gate fire. Ctrl+C tears it down.
#
#   ./trueforge/run_local.sh
#
# Needs (in .env): ANTHROPIC_API_KEY (your key) and MCP_WRITE_TOKEN (any shared secret).
# Uses the LOCAL sandbox fallback — no Daytona key needed. Node 22 required (better-sqlite3).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY in .env}"
: "${MCP_WRITE_TOKEN:?set MCP_WRITE_TOKEN in .env (any shared secret; the write server + register-write.sh use it)}"
TRUEFORGE_URL="${TRUEFORGE_URL:-http://localhost:8790}"

node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' \
  || { echo "need Node >= 22 (better-sqlite3 SIGSEGVs on 20 here). Run: fnm use 22"; exit 1; }

pids=()
cleanup() { echo; echo "stopping…"; for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup INT TERM EXIT

echo "1/6 production Postgres (docker)…"
docker compose up -d >/dev/null
for i in $(seq 1 30); do docker compose exec -T db pg_isready -U "${POSTGRES_USER:-shadow}" >/dev/null 2>&1 && break; sleep 1; done

echo "2/6 read-only MCP  (:${MCP_PORT:-8000})…"
node mcp/postgres/server.js >/tmp/shadow-mcp-read.log 2>&1 &  pids+=($!)
echo "3/6 write MCP      (:${MCP_WRITE_PORT:-8001})…"
node mcp/postgres/write_server.js >/tmp/shadow-mcp-write.log 2>&1 &  pids+=($!)

echo "4/6 TrueForge harness (:8790)…"
npx @truefoundry/trueforge --port 8790 >/tmp/shadow-harness.log 2>&1 &  pids+=($!)
for i in $(seq 1 60); do curl -fsS "${TRUEFORGE_URL}/api/v1/capabilities" >/dev/null 2>&1 && break; sleep 1; done

echo "5/6 registering model, MCP servers, skill, agent…"
./trueforge/register-model.sh
./mcp/postgres/register.sh
./mcp/postgres/register-write.sh
./trueforge/register-skill.sh
./trueforge/register-agent.sh

echo "6/6 up. capabilities:"
curl -fsS "${TRUEFORGE_URL}/api/v1/capabilities" || true
cat <<EOF

SHADOW is running. Open a session with a migration request:

  curl -fsS -X POST ${TRUEFORGE_URL}/api/v1/sessions \\
    -H 'Content-Type: application/json' \\
    -d '{"agent":{"name":"shadow"},"messages":[{"type":"user.message","content":"Make users.email NOT NULL and UNIQUE."}]}'

Watch: it introspects via the read MCP, dry-runs on the shadow, reports SAFE-WITH-FIX, and
pauses at the apply_migration approval gate before touching production.
Logs: /tmp/shadow-harness.log, /tmp/shadow-mcp-{read,write}.log.  Ctrl+C to stop.
EOF
wait
