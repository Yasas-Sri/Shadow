#!/usr/bin/env bash
# Reset production + drop any shadow, in one command (§7 demo safety).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
U="${POSTGRES_USER:-shadow}"

psql() { docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$U" "$@"; }

echo "waiting for db..."
until docker compose exec -T db pg_isready -U "$U" >/dev/null 2>&1; do sleep 1; done

echo "dropping shadow + production..."
psql -d postgres -c "DROP DATABASE IF EXISTS shadow WITH (FORCE);"
psql -d postgres -c "DROP DATABASE IF EXISTS production WITH (FORCE);"
psql -d postgres -c "CREATE DATABASE production;"

echo "applying schema..."
psql -d production < seed/schema.sql

echo "seeding (deterministic)..."
python3 seed/seed.py | psql -d production

echo "verifying engineered anomalies..."
psql -d production -c "
  SELECT count(*) FILTER (WHERE email IS NULL) AS null_emails,
         (SELECT count(*) FROM (SELECT email FROM users WHERE email IS NOT NULL
            GROUP BY email HAVING count(*) > 1) d) AS dup_values,
         (SELECT count(*) FROM audit_log) AS audit_rows,
         count(*) AS users
  FROM users;"
echo "reset complete."
