#!/usr/bin/env bash
# Daily database backup. Keeps 14 days locally; also copies to S3 if BACKUP_S3_BUCKET is set.
#   Run by hand:   ./scripts/backup.sh
#   Schedule it:   crontab -e   →   15 3 * * * cd /home/ubuntu/hirely && ./scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
file="backups/hirely-$(date +%Y-%m-%d-%H%M).sql.gz"
docker compose exec -T db pg_dump -U hirely -d hirely --no-owner | gzip > "$file"
echo "Saved $file ($(du -h "$file" | cut -f1))"
find backups -name 'hirely-*.sql.gz' -mtime +14 -delete
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  aws s3 cp "$file" "s3://${BACKUP_S3_BUCKET}/hirely/$(basename "$file")"
fi
