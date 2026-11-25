#!/usr/bin/env bash
# Quick rebuild: re-compile current code, copy assets, restart pm2, verify.
# Use when you've already pushed commits and just need a fresh build.
# Does NOT git pull — do that first if you want the latest code.
#
# NEVER run bare `rm -rf .next && npm run build && pm2 restart` without the
# cp steps — that breaks static chunk serving (all pages show "couldn't load").
# Always use this script instead.
#
# Usage (from /opt/wacrm on the VPS):
#   bash scripts/rebuild.sh
set -euo pipefail
cd /opt/wacrm

echo ""
echo "══════════════════════════════════════════════"
echo "  Halo rebuild  —  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "══════════════════════════════════════════════"

echo ""
echo "[1/5] Clearing stale build output..."
rm -rf .next

echo ""
echo "[2/5] Building (TypeScript check skipped — not enough RAM on VPS)..."
SKIP_TYPECHECK=1 npm run build

echo ""
echo "[3/5] Copying static assets into standalone (REQUIRED for chunk serving)..."
cp -r .next/static    .next/standalone/.next/
cp -r public          .next/standalone/
echo "  ✓  .next/static  →  .next/standalone/.next/static"
echo "  ✓  public        →  .next/standalone/public"

echo ""
echo "[4/5] Sourcing .env.local and restarting pm2..."
set -a && . .env.local && set +a
pm2 restart wacrm --update-env
pm2 save
echo "  ✓  pm2 restarted"

echo ""
echo "[5/5] Waiting 10 s for server to warm up, then verifying..."
sleep 10
bash scripts/verify.sh
