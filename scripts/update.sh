#!/usr/bin/env bash
# Pull the latest code (if using git), rebuild and restart with zero manual steps.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -d .git ]; then git pull --ff-only; fi
./scripts/backup.sh
docker compose up -d --build
docker compose ps
