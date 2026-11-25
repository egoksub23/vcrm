#!/usr/bin/env bash
# Full production deploy for Halo.
# pull → install → build → copy assets → restart pm2 → verify
#
# Usage (from /opt/wacrm on the VPS):
#   bash scripts/deploy.sh
#
# If only the code changed (no dependency updates), you can skip npm ci:
#   SKIP_INSTALL=1 bash scripts/deploy.sh
set -euo pipefail
cd /opt/wacrm

echo ""
echo "══════════════════════════════════════════════"
echo "  Halo full deploy  —  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "══════════════════════════════════════════════"

echo ""
echo "[1/6] Pulling latest code from main..."
git pull origin main
echo "  Current HEAD: $(git rev-parse --short HEAD) — $(git log -1 --format='%s')"

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  echo ""
  echo "[2/6] Installing production dependencies..."
  npm ci --omit=dev
else
  echo ""
  echo "[2/6] Skipping npm ci (SKIP_INSTALL=1)"
fi

echo ""
echo "[3/6] Building (TypeScript check skipped — not enough RAM on VPS)..."
rm -rf .next
SKIP_TYPECHECK=1 npm run build

echo ""
echo "[4/6] Copying static assets into standalone (REQUIRED for chunk serving)..."
cp -r .next/static    .next/standalone/.next/
cp -r public          .next/standalone/
echo "  ✓  .next/static  →  .next/standalone/.next/static"
echo "  ✓  public        →  .next/standalone/public"

echo ""
echo "[5/6] Sourcing .env.local and restarting pm2..."
set -a && . .env.local && set +a
pm2 restart wacrm --update-env
pm2 save
echo "  ✓  pm2 restarted ($(pm2 show wacrm | grep 'pid' | awk '{print $4}'))"

echo ""
echo "[6/6] Waiting 10 s for server to warm up, then verifying..."
sleep 10
bash scripts/verify.sh
