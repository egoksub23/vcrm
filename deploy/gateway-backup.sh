#!/usr/bin/env bash
# Nightly backup of the Vircle Chat gateway's database (docs/vircle-chat-gateway-runbook.md).
#
#   /opt/wacrm/deploy/gateway-backup.sh                  # one backup now
#   15 2 * * * /opt/wacrm/deploy/gateway-backup.sh >> /var/log/gateway-backup.log 2>&1     # cron, 02:15 every night
#
# Writes /opt/backups/gateway/gateway-YYYY-MM-DD-HHMM.sql.gz (readable by root only), checks the dump is whole before
# keeping it, deletes dumps older than KEEP_DAYS, and exits non-zero (so cron mail / your monitor notices) when anything
# is wrong. A backup on the same machine does not survive losing the machine: set OFFSITE_RSYNC (user@host:/path/) or copy
# the folder somewhere else on a schedule.
#
# The dump holds the Halo signing secret ENCRYPTED with GATEWAY_ENCRYPTION_KEY from .env.gateway. Keep that key
# somewhere other than this server: a backup without it cannot be used.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/gateway}"
KEEP_DAYS="${KEEP_DAYS:-14}"
COMPOSE=(docker compose -f "$REPO_DIR/docker-compose.gateway.yml" --env-file "$REPO_DIR/.env.gateway")

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date +%F-%H%M)"
out="$BACKUP_DIR/gateway-$stamp.sql.gz"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

"${COMPOSE[@]}" exec -T gateway-db pg_dump -U gateway --no-owner --no-privileges gateway | gzip -6 > "$tmp"

# A dump that is not whole is worse than none: it looks like a backup.
gzip -t "$tmp"
size="$(wc -c < "$tmp")"
if [ "$size" -lt 2000 ]; then
  echo "$(date -Is) backup FAILED: dump is only $size bytes" >&2
  exit 1
fi
if ! zcat "$tmp" | grep -q 'CREATE TABLE public.schema_migrations'; then
  echo "$(date -Is) backup FAILED: dump has no schema_migrations table, so it is incomplete" >&2
  exit 1
fi

mv "$tmp" "$out"
trap - EXIT
find "$BACKUP_DIR" -maxdepth 1 -name 'gateway-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

if [ -n "${OFFSITE_RSYNC:-}" ]; then
  rsync -a "$out" "$OFFSITE_RSYNC"
  echo "$(date -Is) copied to $OFFSITE_RSYNC"
fi
echo "$(date -Is) backup ok: $out ($size bytes), keeping $KEEP_DAYS days"
