// WOW #1 — dry-run the email UNIQUE+NOT NULL migration on the shadow clone.
//
// Proves the safe-migration methodology (SKILL.md §"Validation checklist") end to end
// on a throwaway pglite clone of production:
//   1. clone production -> shadow
//   2. run the constraint-violation checks BEFORE altering (find the 5 nulls + 3 dups)
//   3. actually attempt the forward migration and watch it FAIL (honest dry-run)
//   4. generate a backfill+dedupe fix, apply it on the shadow, prove violations -> 0
//   5. re-run the forward migration and watch it PASS; confirm the rollback restores
//   6. emit a SAFE / SAFE-WITH-FIX / UNSAFE verdict with numbers
//
//   node agent/scripts/dry_run.mjs [dumpDir]   # default: seed/dump
//
// Harness-independent: pure Node + pglite, no server, no MCP. This is the sandbox script
// the agent runs; the MCP tools only do the read-only introspection beat separately.
import { cloneShadow } from "./clone_shadow.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The requested change, as forward + reversible rollback (SKILL.md: always pair them).
const FORWARD = `
  ALTER TABLE users ALTER COLUMN email SET NOT NULL;
  ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);`;
const ROLLBACK = `
  ALTER TABLE users DROP CONSTRAINT users_email_unique;
  ALTER TABLE users ALTER COLUMN email DROP NOT NULL;`;
// Fix: backfill nulls with a deterministic placeholder, disambiguate duplicates by id.
// Disambiguation over deletion — never silently drop user rows (no data loss). The min(id)
// per email keeps its original address; the rest get a +id tag so UNIQUE holds.
const FIX = `
  UPDATE users SET email = 'user' || id || '@shadow.invalid' WHERE email IS NULL;
  UPDATE users u SET email =
      split_part(u.email, '@', 1) || '+' || u.id || '@' || split_part(u.email, '@', 2)
    FROM (SELECT id, row_number() OVER (PARTITION BY email ORDER BY id) rn
            FROM users WHERE email IS NOT NULL) d
    WHERE d.id = u.id AND d.rn > 1;`;

// Constraint-violation checks — counts + a MASKED sample (ids / prefix only, never full PII).
async function violations(db) {
  const nulls = (await db.query(`SELECT count(*)::int n FROM users WHERE email IS NULL`)).rows[0].n;
  const nullSample = (await db.query(
    `SELECT id FROM users WHERE email IS NULL ORDER BY id LIMIT 5`)).rows.map((r) => r.id);
  const dups = (await db.query(
    `SELECT count(*)::int n FROM (
       SELECT email FROM users WHERE email IS NOT NULL GROUP BY email HAVING count(*) > 1) d`)).rows[0].n;
  const dupSample = (await db.query(
    `SELECT left(email, 2) || '***@' || split_part(email, '@', 2) AS masked, count(*)::int n
       FROM users WHERE email IS NOT NULL GROUP BY email HAVING count(*) > 1 ORDER BY 1 LIMIT 5`)).rows;
  return { nulls, nullSample, dups, dupSample };
}

// Attempt a migration inside a transaction. rollback:true = dry-run (never persists).
async function attempt(db, sql, { rollback = true } = {}) {
  await db.exec("BEGIN");
  try {
    await db.exec(sql);
    await db.exec(rollback ? "ROLLBACK" : "COMMIT");
    return { ok: true };
  } catch (e) {
    await db.exec("ROLLBACK");
    return { ok: false, error: e.message.split("\n")[0] };
  }
}

export async function dryRun(dumpDir = "seed/dump") {
  const db = await cloneShadow(dumpDir);
  const report = { forward: FORWARD.trim(), rollback: ROLLBACK.trim() };

  report.before = await violations(db);
  const first = await attempt(db, FORWARD); // honest dry-run: should FAIL on the anomalies

  if (first.ok) {
    report.verdict = "SAFE";
  } else {
    report.forwardError = first.error;
    report.fix = FIX.trim();
    await db.exec(FIX); // apply the fix on the shadow (persist), then re-check + re-run
    report.after = await violations(db);
    const second = await attempt(db, FORWARD, { rollback: false });
    if (second.ok && report.after.nulls === 0 && report.after.dups === 0) {
      report.verdict = "SAFE-WITH-FIX";
      // rollback must restore the pre-migration schema shape
      report.rollbackOk = (await attempt(db, ROLLBACK)).ok;
    } else {
      report.verdict = "UNSAFE";
      report.secondError = second.error;
    }
  }
  await db.close();
  return report;
}

function printReport(r) {
  const b = r.before;
  console.log(`\nSHADOW dry-run — make users.email NOT NULL + UNIQUE\n`);
  console.log(`forward:\n${r.forward}\nrollback:\n${r.rollback}\n`);
  console.log(`constraint check (before):`);
  console.log(`  NOT NULL: ${b.nulls} null email(s) — sample ids ${JSON.stringify(b.nullSample)}`);
  console.log(`  UNIQUE:   ${b.dups} duplicated email(s) — masked ${JSON.stringify(b.dupSample)}`);
  if (r.forwardError) console.log(`\ndry-run forward FAILED (expected): ${r.forwardError}`);
  if (r.fix) {
    console.log(`\nproposed fix (backfill nulls, disambiguate dups — no rows deleted):\n${r.fix}`);
    console.log(`\nafter fix: ${r.after.nulls} nulls, ${r.after.dups} dups — forward now applies clean`);
    console.log(`rollback restores original schema: ${r.rollbackOk ? "yes" : "NO"}`);
  }
  console.log(`\nVERDICT: ${r.verdict}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = await dryRun(process.argv[2] ?? "seed/dump");
  printReport(r);
  // self-check: the engineered anomalies must be caught, fixed, and proven on the shadow.
  const ok = r.verdict === "SAFE-WITH-FIX" && r.before.nulls === 5 && r.before.dups === 3 &&
    r.after.nulls === 0 && r.after.dups === 0 && r.rollbackOk;
  if (!ok) { console.error("FAIL: dry-run did not catch+fix+prove the migration"); process.exit(1); }
  console.log("ok: caught 5 nulls + 3 dups, fixed on shadow, migration proven safe");
}
