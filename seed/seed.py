#!/usr/bin/env python3
"""Deterministic seed for SHADOW . Emits a COPY stream on stdout; pipe into psql.

    python3 seed/seed.py | docker compose exec -T db psql -U shadow -d production

No DB driver needed on the host -- Postgres COPY does the loading. Fixed seed => the
demo migration always catches the same engineered problems (null + duplicate emails).
"""
import random
import sys

SEED = 42
N_ORGS = 200
N_USERS = 40_000
N_INVOICES = 1_000
N_AUDIT = 150_000

# Engineered anomalies the demo depends on -- do NOT clean away (§7).
N_NULL_EMAILS = 5          # rows with email IS NULL
DUP_VALUES = 3             # distinct email values that get reused
DUP_COPIES = 2             # times each duplicated value appears

random.seed(SEED)
w = sys.stdout.write


def copy_block(table, columns, rows):
    w(f"COPY {table} ({', '.join(columns)}) FROM STDIN;\n")
    for r in rows:
        w("\t".join(r) + "\n")
    w("\\.\n")


# organizations: ids 1..N_ORGS in emission order (serial fills them).
copy_block("organizations", ["name"],
           ([f"Org {i}"] for i in range(1, N_ORGS + 1)))

# users. Build emails first so we can inject the anomalies deterministically.
emails = [f"user{i}@example.com" for i in range(1, N_USERS + 1)]

# duplicates: reuse a handful of addresses on distinct mid-table rows
# (kept clear of the null tail below so the two anomalies never collide).
dup_rows = []
for d in range(DUP_VALUES):
    src = 100 + d                      # value we duplicate: user101@, user102@...
    for c in range(1, DUP_COPIES):     # extra copies beyond the original
        victim = 5_000 + d * DUP_COPIES + c
        emails[victim] = emails[src]
        dup_rows.append(victim + 1)

# nulls: last few rows lose their email.
null_rows = list(range(N_USERS - N_NULL_EMAILS, N_USERS))
for idx in null_rows:
    emails[idx] = None


def user_rows():
    for i in range(N_USERS):
        org = random.randint(1, N_ORGS)
        email = "\\N" if emails[i] is None else emails[i]
        yield [str(org), email, f"User {i + 1}"]


copy_block("users", ["org_id", "email", "name"], user_rows())

copy_block("subscriptions", ["org_id", "plan", "status"],
           ([str(i), random.choice(["free", "pro", "enterprise"]),
             random.choice(["active", "past_due", "canceled"])]
            for i in range(1, N_ORGS + 1)))

copy_block("invoices", ["org_id", "amount_cents", "status"],
           ([str(random.randint(1, N_ORGS)), str(random.randint(500, 500_00)),
             random.choice(["paid", "open", "void"])]
            for _ in range(N_INVOICES)))

copy_block("audit_log", ["user_id", "action"],
           ([str(random.randint(1, N_USERS)),
             random.choice(["login", "logout", "update_profile", "invite", "export"])]
            for _ in range(N_AUDIT)))


assert emails.count(None) == N_NULL_EMAILS, "null-email count drifted"
non_null = [e for e in emails if e is not None]
assert len(non_null) - len(set(non_null)) == DUP_VALUES * (DUP_COPIES - 1), "dup count drifted"
sys.stderr.write(
    f"seed: {N_USERS} users ({N_NULL_EMAILS} null, "
    f"{DUP_VALUES * (DUP_COPIES - 1)} duplicate emails at rows {sorted(dup_rows)}), "
    f"{N_AUDIT} audit_log rows.\n")
