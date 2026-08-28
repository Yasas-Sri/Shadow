#!/usr/bin/env node
// Write-capable Postgres MCP server for SHADOW — the ONE tool that touches production.
// Kept separate from the read-only introspection server (server.js) so that server stays
// provably read-only; every write path lives here, behind a single guarded tool.
//
//   node mcp/postgres/write_server.js              # serve on http://localhost:$MCP_WRITE_PORT/mcp
//   node mcp/postgres/write_server.js --selfcheck  # prove apply + auto-rollback-on-error
//
// The safety gate is NOT in this code — it is the harness. `apply_migration` is registered
// with `require_approval_for_tools`, so TrueForge pauses for a human before it ever runs and
// shows them the tool arguments (the exact SQL, the row count, the irreversibility note).
// This server just executes what the human approved, in one transaction, rollback in hand.
const http = require("http");
const { Pool } = require("pg");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

const DB_URL = process.env.SHADOW_DATABASE_URL || "postgres://shadow:shadow@localhost:5432/production";
const PORT = Number(process.env.MCP_WRITE_PORT || 8001);
// Shared secret the harness sends as `Authorization: Bearer <token>` (registered via
// register-write.sh's auth.header). Without it, the approval gate would live only in the
// AgentSpec while the write tool sat open on a port — so serving without it is refused.
const TOKEN = process.env.MCP_WRITE_TOKEN || "";
const MAX_BODY = 256 * 1024; // ponytail: a migration request is tiny; 256KB is already generous

const pool = new Pool({ connectionString: DB_URL, max: 2 });

// Apply forward_sql to production in ONE transaction (Postgres DDL is transactional): a
// migration whose statements all fail-and-throw rolls back whole, so it never half-applies.
// ponytail: this is NOT a sandbox for arbitrary SQL — if the migration itself issues COMMIT/
// ROLLBACK it can end this transaction early, and sequence bumps (nextval/setval) aren't
// undone by rollback. That's acceptable because the SQL is agent-authored, human-approved,
// and only the harness (holding the token) can reach this tool — not an untrusted caller.
async function applyMigration(forwardSql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(forwardSql);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

function buildServer() {
  const server = new McpServer({ name: "shadow-postgres-write", version: "0.1.0" });

  // The arguments here are exactly what the human sees at the approval checkpoint — so they
  // carry the whole "what am I approving": the exact SQL, the shadow-measured row impact,
  // and the plain statement that this is irreversible without the rollback.
  server.registerTool("apply_migration", {
    description:
      "Apply an already-shadow-validated migration to PRODUCTION. Irreversible: a human must " +
      "approve this call. Pass the exact forward SQL, its rollback SQL, the row count measured " +
      "on the shadow, and a one-line summary — these are shown at the approval gate.",
    inputSchema: {
      summary: z.string().describe("One-line plain-English description of the change."),
      forward_sql: z.string().describe("Exact forward migration SQL, as proven safe on the shadow."),
      rollback_sql: z.string().describe("Exact SQL that reverses it, run if you need to undo."),
      estimated_rows: z.number().int().describe("Rows the migration touches, measured on the shadow clone."),
    },
  }, async ({ summary, forward_sql, rollback_sql, estimated_rows }) => {
    try {
      await applyMigration(forward_sql);
      return text({
        applied: true,
        summary,
        rows_affected: estimated_rows,
        rollback_sql,
        note: "Applied to production in a single transaction. To undo, run the rollback_sql above.",
      });
    } catch (e) {
      // The transaction rolled back. Honest caveat: if the migration issued its own COMMIT or
      // advanced a sequence, that part isn't reverted — so report failure, don't claim untouched.
      return text({ applied: false, error: e?.message ?? String(e),
        note: "Migration failed and was rolled back. If it committed early or advanced a sequence, verify state and run rollback_sql if needed.",
      });
    }
  });

  return server;
}

async function handle(req, res) {
  const path = req.url.split("?")[0];
  if (req.method === "GET" && path === "/health") { res.writeHead(200).end("ok"); return; }
  if (path !== "/mcp") { res.writeHead(404).end("not found"); return; }

  // The approval gate only means something if nothing but the harness can reach this write
  // tool. Enforce the shared token at the wire, so a direct caller on this port can't bypass
  // TrueForge's checkpoint and run production SQL. (Health stays open for liveness probes.)
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end("unauthorized"); return; }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) { res.writeHead(413).end("payload too large"); req.destroy(); return; }
  }
  let parsed;
  if (body) { try { parsed = JSON.parse(body); } catch { res.writeHead(400).end("bad json"); return; } }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

async function selfcheck() {
  // Apply then reverse a harmless throwaway table; then prove a bad migration rolls back whole.
  await applyMigration("CREATE TABLE _shadow_apply_check(i int); INSERT INTO _shadow_apply_check VALUES (1)");
  const r = await pool.query("SELECT count(*)::int n FROM _shadow_apply_check");
  if (r.rows[0].n !== 1) throw new Error("apply FAILED: statements did not commit");
  console.log("apply ok: transactional migration committed");
  await applyMigration("DROP TABLE _shadow_apply_check");

  let rolledBack = false;
  try {
    // 2nd statement fails -> the 1st must NOT persist (whole-txn rollback).
    await applyMigration("CREATE TABLE _shadow_apply_check(i int); SELECT 1/0");
  } catch {
    const g = await pool.query("SELECT to_regclass('_shadow_apply_check') IS NULL AS gone");
    rolledBack = g.rows[0].gone;
  }
  if (!rolledBack) throw new Error("rollback-on-error FAILED: a failed migration half-applied");
  console.log("rollback-on-error ok: failed migration left production untouched");
  await pool.end();
}

if (require.main === module) {
  if (process.argv.includes("--selfcheck")) {
    selfcheck().catch((e) => { console.error(e.message); process.exit(1); });
  } else {
    if (!TOKEN) { console.error("refusing to start: set MCP_WRITE_TOKEN (shared secret the harness sends)"); process.exit(1); }
    http.createServer((req, res) =>
      handle(req, res).catch((e) => { try { res.writeHead(500).end(String(e?.message ?? e)); } catch {} })
    ).listen(PORT, () => console.error(`shadow-postgres-write MCP on http://localhost:${PORT}/mcp`));
  }
}
