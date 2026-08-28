#!/usr/bin/env bash
# Register the SHADOW agent — the one AgentSpec that ties everything together:
#   - read-only `postgres` MCP           (introspection: list_tables/describe_table/run_query)
#   - write `postgres-write` MCP         (apply_migration) GUARDED by require_approval_for_tools
#   - the `safe-migration` skill         (methodology + validation checklist)
#   - sandbox + subagents + ask-user     (dry-run clone, dynamic validation, clarifying Qs)
# The approval gate is this line: require_approval_for_tools:["apply_migration"]. TrueForge
# pauses before that tool runs and shows the human its arguments (exact SQL, rows, rollback).
#
# Register the two MCP servers, the skill, and a sandbox FIRST (see the other register-*.sh),
# then run this. POST /api/v1/agents creates by name; this script deletes an existing "shadow"
# first so it is re-runnable.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

TRUEFORGE_URL="${TRUEFORGE_URL:-http://localhost:8790}"
MODEL_FQN="${SHADOW_MODEL:-anthropic/claude-opus-4-8}"

node - "$TRUEFORGE_URL" "$MODEL_FQN" <<'NODE'
const [base, model] = process.argv.slice(2);
const fs = require("fs");
const instructions = fs.readFileSync("agent/prompts/system.md", "utf8");

const spec = {
  name: "shadow",
  manifest: {
    model: { name: model, params: { reasoning_effort: "medium" } },
    instructions,
    mcp_servers: [
      { name: "postgres", enable_tools: ["@all"] },
      // The write path: expose only apply_migration, and require human approval for it.
      { name: "postgres-write", enable_tools: ["apply_migration"], require_approval_for_tools: ["apply_migration"] },
    ],
    skills: [{ name: "safe-migration" }],
    config: {
      sandbox: { enabled: true },
      dynamic_sub_agents: { enabled: true },
      ask_user_questions: { enabled: true },
    },
  },
};

async function main() {
  // Idempotent: drop an existing "shadow" agent so re-runs don't 409.
  const list = await fetch(`${base}/api/v1/agents`).then((r) => r.json()).catch(() => ({}));
  const existing = (list.data || []).find((a) => a.name === "shadow");
  if (existing) {
    await fetch(`${base}/api/v1/agents/${existing.id}`, { method: "DELETE" });
    console.error(`deleted existing shadow agent (${existing.id})`);
  }
  const res = await fetch(`${base}/api/v1/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
  const out = await res.json();
  if (!res.ok) { console.error(`FAILED (${res.status}):`, JSON.stringify(out)); process.exit(1); }
  console.log(`registered SHADOW agent (id ${out.data?.id}) — model ${model}`);
  console.log("approval gate: apply_migration requires human approval before it touches production");
}
main().catch((e) => { console.error(e.message); process.exit(1); });
NODE
