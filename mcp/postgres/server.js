#!/usr/bin/env node
// Read-only Postgres MCP server for SHADOW, spoken over Streamable HTTP.
// TrueForge only connects to *remote* MCP servers (McpServerType = "remote"),
// so this is an HTTP endpoint the harness registers by URL, not a stdio subprocess.
//
//   node mcp/postgres/server.js              # serve on http://localhost:$MCP_PORT/mcp
//   node mcp/postgres/server.js --selfcheck  # prove DB reach + read-only guard
//
// Read-only is enforced by Postgres itself: every query runs inside a
// READ ONLY transaction, so writes/DDL fail regardless of the SQL text.
const http = require("http");
const { Pool } = require("pg");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

const DB_URL = process.env.SHADOW_DATABASE_URL || "postgres://shadow:shadow@localhost:5432/production";
const PORT = Number(process.env.MCP_PORT || 8000);
const MAX_ROWS = 200; // ponytail: cap result size; raise if a validation needs more rows

const pool = new Pool({ connectionString: DB_URL, max: 4 });

async function readOnly(sql, params) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const res = await client.query(sql, params);
    await client.query("COMMIT");
    return res;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });
const errText = (e) => ({ content: [{ type: "text", text: "ERROR: " + (e?.message ?? String(e)) }], isError: true });

function buildServer() {
  const server = new McpServer({ name: "shadow-postgres", version: "0.1.0" });

  server.registerTool("list_tables", {
    description: "List base tables in a schema (default public) with estimated row counts.",
    inputSchema: { schema: z.string().default("public") },
  }, async ({ schema }) => {
    try {
      const r = await readOnly(
        `SELECT c.relname AS table, c.reltuples::bigint AS est_rows
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`, [schema]);
      return text(r.rows);
    } catch (e) { return errText(e); }
  });

  server.registerTool("describe_table", {
    description: "Columns (type, nullability, default) and constraints for one table.",
    inputSchema: { table: z.string(), schema: z.string().default("public") },
  }, async ({ table, schema }) => {
    try {
      const cols = await readOnly(
        `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, table]);
      const cons = await readOnly(
        `SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE n.nspname = $1 AND rel.relname = $2 ORDER BY con.conname`, [schema, table]);
      return text({ columns: cols.rows, constraints: cons.rows });
    } catch (e) { return errText(e); }
  });

  server.registerTool("run_query", {
    description: `Run one READ-ONLY SQL query (SELECT / introspection). Writes and DDL are rejected. Returns up to ${MAX_ROWS} rows.`,
    inputSchema: { sql: z.string() },
  }, async ({ sql }) => {
    try {
      const r = await readOnly(sql);
      return text({ rowCount: r.rowCount, returned: Math.min(r.rows.length, MAX_ROWS), rows: r.rows.slice(0, MAX_ROWS) });
    } catch (e) { return errText(e); }
  });

  return server;
}

async function handle(req, res) {
  const path = req.url.split("?")[0];
  if (req.method === "GET" && path === "/health") { res.writeHead(200).end("ok"); return; }
  if (path !== "/mcp") { res.writeHead(404).end("not found"); return; }

  let body = "";
  for await (const chunk of req) body += chunk;
  let parsed;
  if (body) { try { parsed = JSON.parse(body); } catch { res.writeHead(400).end("bad json"); return; } }

  // Stateless: a fresh server+transport per request (sessionIdGenerator: undefined).
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

async function selfcheck() {
  const r = await readOnly(`SELECT count(*) FILTER (WHERE email IS NULL) AS null_emails FROM users`);
  console.log("introspection ok:", r.rows[0]);
  let blocked = false;
  try { await readOnly("CREATE TABLE _shadow_selfcheck(i int)"); } catch { blocked = true; }
  if (!blocked) throw new Error("read-only guard FAILED: a write was allowed");
  console.log("read-only guard ok: writes rejected");
  await pool.end();
}

if (require.main === module) {
  if (process.argv.includes("--selfcheck")) {
    selfcheck().catch((e) => { console.error(e.message); process.exit(1); });
  } else {
    http.createServer((req, res) =>
      handle(req, res).catch((e) => { try { res.writeHead(500).end(String(e?.message ?? e)); } catch {} })
    ).listen(PORT, () => console.error(`shadow-postgres MCP on http://localhost:${PORT}/mcp`));
  }
}
