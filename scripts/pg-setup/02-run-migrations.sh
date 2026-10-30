#!/usr/bin/env bash
# ============================================================
# 02-run-migrations.sh
#
# Applies all Supabase migrations to a self-hosted PostgreSQL
# instance. Run AFTER 01-auth-shim.sql has been applied.
#
# Usage (from repo root):
#   PG_URL="postgresql://halo_admin:<password>@localhost:5432/halo_uat" \
#     bash scripts/pg-setup/02-run-migrations.sh
#
# Or with a local socket (no password):
#   PGUSER=postgres PGDATABASE=halo_uat \
#     bash scripts/pg-setup/02-run-migrations.sh
# ============================================================

set -euo pipefail

MIGRATIONS_DIR="$(cd "$(dirname "$0")/../../supabase/migrations" && pwd)"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "ERROR: migrations directory not found at $MIGRATIONS_DIR"
  exit 1
fi

# Apply the auth shim first (idempotent — safe to re-run)
SHIM="$(dirname "$0")/01-auth-shim.sql"
echo "▶ Applying auth shim..."
if [[ -n "${PG_URL:-}" ]]; then
  psql "$PG_URL" -f "$SHIM"
else
  psql -f "$SHIM"
fi

# Apply each migration in filename order
TOTAL=$(ls "$MIGRATIONS_DIR"/*.sql | wc -l)
COUNT=0

for f in "$MIGRATIONS_DIR"/*.sql; do
  name=$(basename "$f")
  COUNT=$((COUNT + 1))
  echo "▶ [$COUNT/$TOTAL] $name"
  if [[ -n "${PG_URL:-}" ]]; then
    psql "$PG_URL" -f "$f" 2>&1 | grep -v "^NOTICE" | grep -v "^$" || true
  else
    psql -f "$f" 2>&1 | grep -v "^NOTICE" | grep -v "^$" || true
  fi
done

echo ""
echo "✓ All $TOTAL migrations applied."
echo ""
echo "Verify with:"
if [[ -n "${PG_URL:-}" ]]; then
  echo "  psql \"$PG_URL\" -c \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';\""
else
  echo "  psql -c \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';\""
fi
