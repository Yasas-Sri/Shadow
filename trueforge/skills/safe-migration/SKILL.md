---
name: safe-migration
description: Use for every Postgres schema-change request. The methodology for turning a plain-English migration into a forward + rollback pair, dry-running it on a shadow clone, validating it, and only then applying to production behind a human approval.
---

# Safe migration

You turn a plain-English schema change into a migration that is **proven safe on a
shadow copy before it ever touches production**. Never apply to production without a
passing (or fixed) shadow dry-run and an explicit human approval. That gate is the
whole point — do not skip it, do not work around it.

## Operating order (never skip a step)

1. **Restate** the requested change in one sentence.
2. **Introspect** the live schema with the read-only Postgres MCP tools
   (`list_tables`, `describe_table`, `run_query`). Never assume a column, type, or
   constraint — look it up.
3. **Generate** the forward migration SQL **and** the rollback SQL. If you cannot
   write a rollback that reverses the forward change, say so loudly and stop.
4. **Clone** `production` → `shadow` (in the sandbox).
5. **Dry-run** the forward migration on `shadow`, then run the validations below.
6. **Report** a verdict — SAFE / SAFE-WITH-FIX / UNSAFE — with numbers.
7. **Stop for approval** before touching `production`. Show exactly what will run and
   that it is irreversible.
8. On approval, **apply** to `production` by calling the `apply_migration` tool (the only
   write path — it is approval-gated; pass the exact forward SQL, its rollback SQL, and the
   shadow-measured row count), with the rollback one command away.

## Validation checklist (run on the shadow clone)

Check at least these before issuing a verdict:

- **Applies cleanly?** Does the forward migration run without error on `shadow`?
- **Constraint violations?** For any new `NOT NULL` / `UNIQUE` / `FOREIGN KEY` /
  `CHECK`, query for the rows that would violate it **before** adding it. Report exact
  counts and a small sample of offending rows — never dump full PII (mask or show ids
  only).
- **Data loss / truncation?** Column drops, type narrowing (e.g. `text` → `varchar(n)`),
  or destructive `UPDATE`s — name exactly what would be lost.
- **Row impact:** how many rows the migration reads and writes.
- **Duration & locking:** does it take a lock that blocks writes (e.g. a rewrite, an
  index build without `CONCURRENTLY`)? Roughly how long on the shadow's real row counts?
- **Rollback validity:** run the rollback on `shadow` and confirm it returns the schema
  to its original shape.

## Verdicts

- **SAFE** — applies, no violations, acceptable lock/duration. Apply on approval.
- **SAFE-WITH-FIX** — a violation exists but a backfill/dedupe/cleanup makes it safe.
  Generate that fix, **apply it on the shadow, and re-run the dry-run to prove it
  works**, then proceed to approval.
- **UNSAFE** — would lose data or cannot be made safe; do not proceed. Explain why.

## Constraint-violation queries (patterns)

- New `NOT NULL` on `col`:
  `SELECT count(*) FROM tbl WHERE col IS NULL;`
- New `UNIQUE` on `col`:
  `SELECT col, count(*) FROM tbl WHERE col IS NOT NULL GROUP BY col HAVING count(*) > 1;`
- New `FOREIGN KEY` `child.fk → parent.id`:
  `SELECT count(*) FROM child c LEFT JOIN parent p ON p.id = c.fk WHERE c.fk IS NOT NULL AND p.id IS NULL;`

## Proposed-fix patterns

- **Nulls before NOT NULL:** backfill a sensible value, or delete/quarantine the rows if
  no value is defensible — state which and why.
- **Duplicates before UNIQUE:** keep one row per key (e.g. lowest `id`) and dedupe the
  rest, or disambiguate the values — show the exact `DELETE`/`UPDATE`.
- Always re-run the full dry-run after applying a fix on the shadow, and report the
  post-fix numbers.

## Locking notes (Postgres)

- `ADD COLUMN ... DEFAULT` on a constant is metadata-only in modern Postgres; a volatile
  default rewrites the table.
- Adding `UNIQUE`/`PRIMARY KEY` builds an index and takes a lock — prefer
  `CREATE UNIQUE INDEX CONCURRENTLY` then `ADD CONSTRAINT ... USING INDEX` for large tables.
- `ALTER TYPE` that rewrites rows takes an `ACCESS EXCLUSIVE` lock — flag it.
