#!/usr/bin/env bash
# Daily database backup. Keeps 14 days locally; also copies to S3 if BACKUP_S3_BUCKET is set.
# Works with the bundled Postgres container, or a hosted database (Supabase) when DIRECT_URL is set in .env.
#   Run by hand:   ./scripts/backup.sh
#   Schedule it:   crontab -e   →   15 3 * * * cd /home/ubuntu/hirely && ./scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
file="backups/hirely-$(date +%Y-%m-%d-%H%M).sql.gz"
direct_url="$(grep -E '^DIRECT_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true)"
if [ -n "$direct_url" ]; then
  # Hosted database: dump the app's schema with a pg_dump that matches the server (Supabase runs Postgres 17).
  docker run --rm --network host postgres:17-alpine pg_dump "$direct_url" --schema=public --no-owner --no-privileges | gzip > "$file"
else
  docker compose exec -T db pg_dump -U hirely -d hirely --no-owner | gzip > "$file"
fi
# An empty or tiny file means the dump failed part-way; keep it for inspection but fail loudly.
if [ "$(gunzip -c "$file" | head -c 2000 | grep -c 'PostgreSQL database dump')" = "0" ]; then
  echo "Backup looks empty or broken: $file" >&2
  exit 1
fi
echo "Saved $file ($(du -h "$file" | cut -f1))"
find backups -name 'hirely-*.sql.gz' -mtime +14 -delete
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  aws s3 cp "$file" "s3://${BACKUP_S3_BUCKET}/hirely/$(basename "$file")"
fi
