#!/usr/bin/env bash
# ============================================================
# Self-hosted PostgreSQL setup — one-time run on the VPS
#
# Prerequisites (all in /opt/wacrm/.env.local):
#   PG_USER, PG_PASSWORD, PG_DB
#   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#   DATABASE_URL=postgresql://$PG_USER:$PG_PASSWORD@postgres:5432/$PG_DB
#
# Run from /opt/wacrm:
#   bash scripts/setup-self-hosted-pg.sh
# ============================================================

set -euo pipefail
cd /opt/wacrm

# Load .env.local into this shell
set -a; source .env.local; set +a

PG_USER="${PG_USER:-wacrm}"
PG_DB="${PG_DB:-wacrm}"
POSTGRES_CONTAINER="wacrm-postgres-1"
APP_CONTAINER="wacrm-app-1"

psql_exec() {
  docker exec -i "$POSTGRES_CONTAINER" \
    psql -U "$PG_USER" -d "$PG_DB" "$@"
}

echo "━━ Step 1: Start PostgreSQL ━━"
docker compose up -d postgres
echo "Waiting for postgres to be ready..."
until docker exec "$POSTGRES_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" &>/dev/null; do
  sleep 1
done
echo "✓ PostgreSQL ready"

echo ""
echo "━━ Step 2: Bootstrap auth schema ━━"
docker cp scripts/bootstrap-pg.sql "$POSTGRES_CONTAINER":/tmp/bootstrap-pg.sql
psql_exec -f /tmp/bootstrap-pg.sql
echo "✓ Auth schema bootstrapped"

echo ""
echo "━━ Step 3: Apply schema migrations ━━"
for f in supabase/migrations/*.sql; do
  echo -n "  $f ... "
  docker cp "$f" "$POSTGRES_CONTAINER":/tmp/migration.sql
  psql_exec -f /tmp/migration.sql -v ON_ERROR_STOP=0 2>&1 | tail -1
done
echo "✓ Migrations applied"

echo ""
echo "━━ Step 4: Migrate auth.users from Supabase ━━"
docker cp scripts/migrate-auth-users.cjs "$APP_CONTAINER":/tmp/migrate-auth-users.cjs
docker exec -e "NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL" \
            -e "SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY" \
            -e "DATABASE_URL=$DATABASE_URL" \
            -e "DATABASE_SSL=false" \
            "$APP_CONTAINER" \
  node /tmp/migrate-auth-users.cjs

echo ""
echo "━━ Step 5: Migrate all public-schema data ━━"
docker cp scripts/migrate-pg.cjs "$APP_CONTAINER":/tmp/migrate-pg.cjs
docker exec -e "NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL" \
            -e "SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY" \
            -e "DATABASE_URL=$DATABASE_URL" \
            -e "DATABASE_SSL=false" \
            "$APP_CONTAINER" \
  node /tmp/migrate-pg.cjs

echo ""
echo "━━ Step 6: Restart app with DATABASE_URL ━━"
docker compose up -d
echo ""
echo "✓ Done. Check app logs with: docker logs wacrm-app-1 --tail 50"
