#!/usr/bin/env bash
set -euo pipefail

# Example PostgreSQL restore script for production dry runs.
# Stop write traffic before restoring. Inject secrets through DATABASE_URL or PGPASSWORD.

BACKUP_FILE="${1:-}"

if [[ -z "${BACKUP_FILE}" ]]; then
  echo "Usage: $0 <backup-file.dump|backup-file.sql>" >&2
  exit 1
fi

if [[ ! -f "${BACKUP_FILE}" ]]; then
  echo "Backup file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

echo "This will restore ${BACKUP_FILE} into the target PostgreSQL database."
echo "Stop API/Web write traffic before continuing."
read -r -p "Type RESTORE to continue: " CONFIRMATION

if [[ "${CONFIRMATION}" != "RESTORE" ]]; then
  echo "Restore cancelled."
  exit 1
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  if [[ "${BACKUP_FILE}" == *.sql ]]; then
    psql "${DATABASE_URL}" --file "${BACKUP_FILE}"
  else
    pg_restore --clean --if-exists --dbname "${DATABASE_URL}" "${BACKUP_FILE}"
  fi
else
  : "${PGHOST:?PGHOST is required when DATABASE_URL is not set}"
  : "${PGUSER:?PGUSER is required when DATABASE_URL is not set}"
  : "${PGDATABASE:?PGDATABASE is required when DATABASE_URL is not set}"

  if [[ "${BACKUP_FILE}" == *.sql ]]; then
    psql \
      --host "${PGHOST}" \
      --port "${PGPORT:-5432}" \
      --username "${PGUSER}" \
      --dbname "${PGDATABASE}" \
      --file "${BACKUP_FILE}"
  else
    pg_restore \
      --host "${PGHOST}" \
      --port "${PGPORT:-5432}" \
      --username "${PGUSER}" \
      --dbname "${PGDATABASE}" \
      --clean \
      --if-exists \
      "${BACKUP_FILE}"
  fi
fi

echo "Restore completed. Run migrate status, health check, login smoke, and key API smoke next."
