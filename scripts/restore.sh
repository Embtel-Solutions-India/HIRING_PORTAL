#!/usr/bin/env bash
# Restore a backup made by backup.sh. THIS REPLACES ALL CURRENT DATA.
#   ./scripts/restore.sh backups/hirely-2026-10-02-0315.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
file="${1:?Usage: ./scripts/restore.sh backups/<file>.sql.gz}"
read -r -p "This will erase the current database and restore $file. Type RESTORE to continue: " answer
[ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }
direct_url="$(grep -E '^DIRECT_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true)"
docker compose stop app
if [ -n "$direct_url" ]; then
  # Hosted database: replace only the app's schema (Supabase keeps its own schemas alongside).
  { echo "drop schema if exists public cascade;"; gunzip -c "$file"; } | docker run --rm -i --network host postgres:17-alpine psql "$direct_url" -q -v ON_ERROR_STOP=1
else
  docker compose exec -T db psql -U hirely -d postgres -c "drop database if exists hirely;" -c "create database hirely owner hirely;"
  gunzip -c "$file" | docker compose exec -T db psql -U hirely -d hirely -q
fi
docker compose start app
echo "Restored $file"
