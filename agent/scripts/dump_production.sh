#!/usr/bin/env bash
# Export live production as TSV (one file per table) -> the bridge the sandbox loads.
# TSV text format (\N for NULL) is exactly what pglite's COPY FROM consumes.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
U="${POSTGRES_USER:-shadow}"

OUT=seed/dump
mkdir -p "$OUT"
# parents first so the sandbox can load in FK order
for t in organizations users subscriptions invoices audit_log; do
  docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$U" -d production \
    -c "\copy $t TO STDOUT" > "$OUT/$t.tsv"
  echo "dumped $t -> $OUT/$t.tsv ($(wc -l < "$OUT/$t.tsv") rows)"
done
