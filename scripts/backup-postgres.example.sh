#!/usr/bin/env bash
set -euo pipefail

# Example PostgreSQL backup script for production dry runs.
# Inject passwords through DATABASE_URL or PGPASSWORD. Do not hard-code secrets here.

BACKUP_DIR="${BACKUP_DIR:-backups}"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/subscription-saas-${TIMESTAMP}.dump"

mkdir -p "${BACKUP_DIR}"

if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump --format=custom --file "${BACKUP_FILE}" "${DATABASE_URL}"
else
  : "${PGHOST:?PGHOST is required when DATABASE_URL is not set}"
  : "${PGUSER:?PGUSER is required when DATABASE_URL is not set}"
  : "${PGDATABASE:?PGDATABASE is required when DATABASE_URL is not set}"

  pg_dump \
    --host "${PGHOST}" \
    --port "${PGPORT:-5432}" \
    --username "${PGUSER}" \
    --dbname "${PGDATABASE}" \
    --format=custom \
    --file "${BACKUP_FILE}"
fi

echo "Backup written to ${BACKUP_FILE}"
