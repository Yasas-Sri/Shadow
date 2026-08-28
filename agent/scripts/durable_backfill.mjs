// WOW #3 — a DURABLE backfill + the duration/locking beat.
//
// A naive fix ("UPDATE the whole table, then ADD the constraint") is fine on 40k rows but
// on a real table it holds one long lock and can't be resumed if it dies halfway. SHADOW
// instead: (1) analyzes what lock each migration step takes and roughly how long, on the
// shadow's real row counts; (2) runs the heavy backfill in bounded, idempotent, resumable
// batches — each its own short transaction, so writes are never blocked for long and a
// crash just re-runs the unfinished batches.
//
//   node agent/scripts/durable_backfill.mjs [dumpDir]   # default: seed/dump
//
// Runs as a sandbox script against the shadow (and, in production, against production — NOT
// through apply_migration, whose single wrapping transaction would defeat the batching).
// apply_migration stays the approval-gated tool for the final, small DDL.
import { cloneShadow } from "./clone_shadow.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Static lock knowledge (SKILL.md "Locking notes") for the email NOT NULL + UNIQUE migration.
// Durations are MEASURED on the shadow at run time, not guessed — see runDurations below.
export function lockPlan() {
  return [
    {
      step: "ALTER TABLE users ALTER COLUMN email SET NOT NULL",
      lock: "ACCESS EXCLUSIVE (brief)", blocks_writes: true,
      note: "Full scan to validate no nulls remain; no table rewrite in PostgreSQL >= 12.",
    },
    {
      step: "ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email)",
      lock: "ACCESS EXCLUSIVE (holds through index build)", blocks_writes: true,
      note: "Builds the unique index while holding the lock — blocks writes for the whole build.",
      safer_for_large_tables:
        "CREATE UNIQUE INDEX CONCURRENTLY users_email_unique ON users(email); " +
        "ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE USING INDEX users_email_unique; " +
        "-- CONCURRENTLY builds without a write lock, but cannot run inside a transaction, so it is a " +
        "separate step, not part of apply_migration's single-txn apply.",
    },
  ];
}

// Batched, idempotent, resumable UPDATE. `sqlFor(lo, hi)` must be a WHERE-bounded statement
// that only matches not-yet-fixed rows, so re-running (after a crash, or start to finish) is
// a no-op on rows already done. Each batch commits on its own — no long lock, no long txn.
export async function batchedBackfill(db, { table = "users", batch = 5000, sqlFor }) {
  const max = (await db.query(`SELECT coalesce(max(id), 0)::int m FROM ${table}`)).rows[0].m;
  const t0 = Date.now();
  let batches = 0, fixed = 0;
  for (let lo = 0; lo < max; lo += batch) {
    const hi = Math.min(lo + batch, max);
    await db.exec("BEGIN");
    const r = await db.query(sqlFor(lo, hi));
    await db.exec("COMMIT");
    batches++; fixed += r.affectedRows ?? 0;
  }
  return { batches, fixed, ms: Date.now() - t0 };
}

async function timed(db, sql) {
  const t0 = Date.now();
  await db.exec(sql);
  return Date.now() - t0;
}

export async function run(dumpDir = "seed/dump") {
  const db = await cloneShadow(dumpDir);
  const report = { lockPlan: lockPlan() };

  // The heavy part of the WOW#1 fix — the null backfill — run durably (batched, resumable).
  const nullBackfill = (lo, hi) =>
    `UPDATE users SET email = 'user' || id || '@shadow.invalid'
       WHERE email IS NULL AND id > ${lo} AND id <= ${hi}`;
  report.backfill = await batchedBackfill(db, { batch: 5000, sqlFor: nullBackfill });
  // Idempotency proof: a second full pass must fix zero rows.
  report.rerun = await batchedBackfill(db, { batch: 5000, sqlFor: nullBackfill });

  // Dedupe is inherently whole-table (group by email), so it is one short statement, not
  // batched — its lock is brief on real counts. Timed on the shadow.
  const dedupeMs = await timed(db,
    `UPDATE users u SET email =
        split_part(u.email, '@', 1) || '+' || u.id || '@' || split_part(u.email, '@', 2)
      FROM (SELECT id, row_number() OVER (PARTITION BY email ORDER BY id) rn
              FROM users WHERE email IS NOT NULL) d
      WHERE d.id = u.id AND d.rn > 1`);

  // Now the small DDL applies cleanly — MEASURE how long each step actually locks on the shadow.
  report.durations_ms = {
    backfill_batched: report.backfill.ms,
    dedupe: dedupeMs,
    set_not_null: await timed(db, "ALTER TABLE users ALTER COLUMN email SET NOT NULL"),
    add_unique: await timed(db, "ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email)"),
  };
  report.remaining_nulls = (await db.query(`SELECT count(*)::int n FROM users WHERE email IS NULL`)).rows[0].n;
  report.remaining_dups = (await db.query(
    `SELECT count(*)::int n FROM (SELECT email FROM users GROUP BY email HAVING count(*) > 1) d`)).rows[0].n;
  await db.close();
  return report;
}

function printReport(r) {
  console.log(`\nSHADOW durable backfill + locking analysis — users.email NOT NULL + UNIQUE\n`);
  console.log("locking plan (what each step locks; durations measured on the shadow below):");
  for (const s of r.lockPlan) {
    console.log(`  • ${s.step}`);
    console.log(`      lock: ${s.lock} — blocks writes: ${s.blocks_writes}`);
    console.log(`      ${s.note}`);
    if (s.safer_for_large_tables) console.log(`      safer (large tables): ${s.safer_for_large_tables}`);
  }
  console.log(`\ndurable backfill: ${r.backfill.fixed} rows in ${r.backfill.batches} batches (${r.backfill.ms}ms)`);
  console.log(`idempotent re-run: fixed ${r.rerun.fixed} rows (expect 0)`);
  console.log(`\nmeasured durations on shadow (ms): ${JSON.stringify(r.durations_ms)}`);
  console.log(`after all steps: ${r.remaining_nulls} nulls, ${r.remaining_dups} duplicate emails — migration applied clean\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = await run(process.argv[2] ?? "seed/dump");
  printReport(r);
  // self-check: backfill is idempotent (2nd pass fixes 0), and the migration ends clean.
  const ok = r.backfill.fixed === 5 && r.rerun.fixed === 0 &&
    r.remaining_nulls === 0 && r.remaining_dups === 0;
  if (!ok) { console.error("FAIL: durable backfill not idempotent or migration not clean"); process.exit(1); }
  console.log("ok: durable batched backfill is idempotent and the migration applies clean");
}
