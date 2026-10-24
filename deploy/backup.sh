#!/usr/bin/env bash
# Dump the database (pg_dump -Fc) and prune old dumps. One output line, for cron.
#
#   ./deploy/backup.sh [label]         (or: make prod-backup)
#
# Env: BACKUP_DIR (~/backups/chemsha-bongo), KEEP_DAYS (14),
#      COMPOSE_FILE (production pair). Restore with deploy/restore.sh.
# Dumps contain emails and password hashes, so they are written mode 600.

set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/chemsha-bongo}"
KEEP_DAYS="${KEEP_DAYS:-14}"
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml:docker-compose.prod.yml}"

label="${1:-}"
# The label becomes part of a file name.
if [[ -n "$label" && ! "$label" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "$(date -u +%FT%TZ) backup FAILED: label may only contain letters, digits, . _ -" >&2
  exit 2
fi

umask 077
mkdir -p "$BACKUP_DIR"

name="chemsha-$(date -u +%Y%m%dT%H%M%SZ)${label:+-$label}.dump"
final="$BACKUP_DIR/$name"
partial="$final.partial"
trap 'rm -f "$partial" "$partial.err"' EXIT

# Runs inside the container (matching pg_dump version); -T keeps binary output intact.
if ! docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' </dev/null >"$partial" 2>"$partial.err"; then
  echo "$(date -u +%FT%TZ) backup FAILED: $(tr '\n' ' ' <"$partial.err")" >&2
  exit 1
fi

if [[ "$(head -c 5 "$partial")" != "PGDMP" ]]; then
  echo "$(date -u +%FT%TZ) backup FAILED: $partial is not a pg_dump file" >&2
  exit 1
fi

mv "$partial" "$final"

deleted=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'chemsha-*.dump' -mtime +"$KEEP_DAYS" -print -delete | wc -l)

echo "$(date -u +%FT%TZ) backup ok: $final ($(du -h "$final" | cut -f1)), $deleted older than $KEEP_DAYS days deleted"
