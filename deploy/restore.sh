#!/usr/bin/env bash
# Restore the database from a dump made by deploy/backup.sh.
#
#   ./deploy/restore.sh ~/backups/chemsha-bongo/chemsha-20261020T190000Z.dump
#   (or: make prod-restore FILE=~/backups/chemsha-bongo/chemsha-....dump)
#
# Replaces the whole database. Asks for confirmation, takes a "pre-restore"
# backup, stops the app, recreates the database and restores in one
# transaction, then starts the app (which reapplies migrations and grants).
# Env: COMPOSE_FILE as in backup.sh.

set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml:docker-compose.prod.yml}"

dump="${1:-}"
if [[ -z "$dump" || ! -f "$dump" ]]; then
  echo "Usage: $0 <file.dump>   (files are in ~/backups/chemsha-bongo by default)" >&2
  exit 2
fi
if [[ "$(head -c 5 "$dump")" != "PGDMP" ]]; then
  echo "$dump is not a pg_dump custom-format file (made by deploy/backup.sh)." >&2
  exit 2
fi

pg_container="$(docker compose ps -q postgres)"
if [[ -z "$pg_container" ]]; then
  echo "The postgres container is not running. Start the stack first (make prod-up)." >&2
  exit 1
fi
project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$pg_container")"
# </dev/null: exec -T would otherwise consume this script's stdin.
db="$(docker compose exec -T postgres sh -c 'echo "$POSTGRES_DB"' </dev/null)"

echo "About to REPLACE database '$db' (compose project '$project')"
echo "with the contents of:  $dump ($(du -h "$dump" | cut -f1), $(date -r "$dump" '+%F %T'))"
echo "Everything written to '$db' after that dump will be lost (a backup is taken first)."
answer=""
read -r -p "Type the database name ($db) to continue: " answer || true
if [[ "$answer" != "$db" ]]; then
  echo "Not confirmed. Nothing was changed."
  exit 1
fi

./deploy/backup.sh pre-restore

trap 'echo "$(date -u +%FT%TZ) restore FAILED. The app is stopped. The database as it was just before is in the pre-restore dump printed above: restore that one, or fix the problem and run this again." >&2' ERR

echo "Stopping the app..."
docker compose stop app

echo "Re-creating '$db' and loading the dump..."
# --force drops other connections (e.g. Grafana's data source).
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --force --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
# --no-owner/--no-acl: objects belong to this server's POSTGRES_USER; the app
# re-grants grafana_reader at start-up.
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --single-transaction --exit-on-error' <"$dump"

echo "Starting the app..."
docker compose start app >/dev/null
echo "$(date -u +%FT%TZ) restore ok: '$db' now holds $dump"
