// Clone production -> shadow, in-process, using pglite (a real Postgres in WASM).
// This runs INSIDE the Daytona sandbox: no Postgres server, no network back to the
// host -- the sandbox is self-contained. Input is the TSV dump from dump_production.sh.
//
//   node agent/scripts/clone_shadow.mjs [dumpDir]   # default: seed/dump
//
// Returns a live pglite handle when imported; prints a fidelity report when run directly.
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const TABLES = ["organizations", "users", "subscriptions", "invoices", "audit_log"];

export async function cloneShadow(dumpDir = "seed/dump", schemaPath = "seed/schema.sql") {
  const db = await PGlite.create();
  await db.exec(await readFile(schemaPath, "utf8"));
  for (const t of TABLES) {
    const tsv = await readFile(path.join(dumpDir, `${t}.tsv`));
    // pglite loads a blob as the COPY source; text format matches psql's \copy TO.
    await db.query(`COPY ${t} FROM '/dev/blob' WITH (FORMAT text)`, [], { blob: new Blob([tsv]) });
  }
  return db;
}

export async function counts(db) {
  const out = {};
  for (const t of TABLES) out[t] = (await db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
  out.null_emails = (await db.query(`SELECT count(*)::int n FROM users WHERE email IS NULL`)).rows[0].n;
  out.dup_emails = (await db.query(
    `SELECT count(*)::int n FROM (SELECT email FROM users WHERE email IS NOT NULL GROUP BY email HAVING count(*)>1) d`
  )).rows[0].n;
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = await cloneShadow(process.argv[2] ?? "seed/dump");
  const c = await counts(db);
  console.log("shadow clone:", JSON.stringify(c));
  // self-check: the clone must reproduce the §7 engineered anomalies exactly.
  if (c.users !== 40000 || c.null_emails !== 5 || c.dup_emails !== 3 || c.audit_log !== 150000) {
    console.error("FAIL: shadow does not match production's engineered dataset");
    process.exit(1);
  }
  console.log("ok: shadow is a faithful clone of production");
  await db.close();
}
