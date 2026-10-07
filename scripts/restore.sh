#!/usr/bin/env bash
# Restore a backup made by backup.sh. THIS REPLACES ALL CURRENT DATA.
#   ./scripts/restore.sh backups/hirely-2026-10-02-0315.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
file="${1:?Usage: ./scripts/restore.sh backups/<file>.sql.gz}"
read -r -p "This will erase the current database and restore $file. Type RESTORE to continue: " answer
[ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }
docker compose stop app
docker compose exec -T db psql -U hirely -d postgres -c "drop database if exists hirely;" -c "create database hirely owner hirely;"
gunzip -c "$file" | docker compose exec -T db psql -U hirely -d hirely -q
docker compose start app
echo "Restored $file"
