#!/usr/bin/env bash
# Restore the Vircle Chat gateway's database from a backup (docs/vircle-chat-gateway-runbook.md).
#
#   gateway-restore.sh --verify /opt/backups/gateway/gateway-2026-10-03-0215.sql.gz
#       Loads the backup into a throwaway database next to the real one, counts what is in it, and drops it.
#       Touches nothing live. Run it once a month: a backup you have never restored is a hope, not a backup.
#
#   gateway-restore.sh --restore /opt/backups/gateway/gateway-2026-10-03-0215.sql.gz
#       REPLACES the live database with the backup. Stops the gateway, loads the backup into a fresh database, starts the
#       gateway. Everything written after the backup was taken is gone (Halo still has the conversations; the app resumes).
#       Asks you to type "restore" first.
set -euo pipefail

mode="${1:-}"
file="${2:-}"
if [ "$mode" != "--verify" ] && [ "$mode" != "--restore" ] || [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "usage: $0 --verify|--restore <backup.sql.gz>" >&2
  exit 2
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$REPO_DIR/docker-compose.gateway.yml" --env-file "$REPO_DIR/.env.gateway")
psql_admin() { "${COMPOSE[@]}" exec -T gateway-db psql -U gateway -d postgres -v ON_ERROR_STOP=1 "$@"; }

gzip -t "$file"

load_into() {
  local db="$1"
  zcat "$file" | "${COMPOSE[@]}" exec -T gateway-db psql -U gateway -d "$db" -v ON_ERROR_STOP=1 -q > /dev/null
}

report() {
  local db="$1"
  "${COMPOSE[@]}" exec -T gateway-db psql -U gateway -d "$db" -At -F ' ' -c "
    SELECT 'workspaces', count(*) FROM workspaces
    UNION ALL SELECT 'users', count(*) FROM users
    UNION ALL SELECT 'conversations', count(*) FROM conversations
    UNION ALL SELECT 'messages', count(*) FROM messages
    UNION ALL SELECT 'files', count(*) FROM files
    UNION ALL SELECT 'outbox_events', count(*) FROM outbox_events
    UNION ALL SELECT 'migrations_applied', count(*) FROM schema_migrations
    UNION ALL SELECT 'newest_message', coalesce(max(created_at)::text, 'none') FROM messages"
}

if [ "$mode" = "--verify" ]; then
  scratch="gateway_verify_$$"
  psql_admin -c "CREATE DATABASE $scratch" > /dev/null
  trap 'psql_admin -c "DROP DATABASE IF EXISTS $scratch" > /dev/null' EXIT
  load_into "$scratch"
  echo "Backup $file restored into a scratch database. It contains:"
  report "$scratch"
  echo "OK: the backup loads. (Scratch database dropped.)"
  exit 0
fi

echo "This REPLACES the live gateway database with $file."
echo "The gateway is stopped while it loads. Anything written after the backup was taken is lost."
read -r -p 'Type "restore" to continue: ' answer
[ "$answer" = "restore" ] || { echo "Cancelled."; exit 1; }

"${COMPOSE[@]}" stop gateway
# Keep the old database under another name until the new one is proven, so a bad backup can be undone.
old="gateway_replaced_$(date +%Y%m%d%H%M%S)"
psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'gateway' AND pid <> pg_backend_pid()" > /dev/null
psql_admin -c "ALTER DATABASE gateway RENAME TO $old"
psql_admin -c "CREATE DATABASE gateway"
if ! load_into gateway; then
  echo "Loading failed. Putting the previous database back." >&2
  psql_admin -c "DROP DATABASE gateway" > /dev/null
  psql_admin -c "ALTER DATABASE $old RENAME TO gateway" > /dev/null
  "${COMPOSE[@]}" start gateway
  exit 1
fi
"${COMPOSE[@]}" start gateway
echo "Restored. The gateway is starting. Contents:"
report gateway
echo "The previous database is kept as '$old'. When you are sure, remove it:"
echo "  docker compose -f docker-compose.gateway.yml --env-file .env.gateway exec gateway-db psql -U gateway -d postgres -c 'DROP DATABASE $old'"
