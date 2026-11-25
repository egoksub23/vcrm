#!/usr/bin/env bash
# Post-deploy health check for Halo (runs on the VPS from /opt/wacrm).
# Exits 0 only when every check passes. Run after every deploy or rebuild.
#
# Usage:
#   bash scripts/verify.sh                 # checks localhost:3000
#   HALO_BASE=https://halo.vircle.tech bash scripts/verify.sh
set -euo pipefail

cd "$(dirname "$0")/.."   # always run from project root
BASE="${HALO_BASE:-http://localhost:3000}"
PASS=0; FAIL=0

check() {
  local label="$1" url="$2" want="${3:-200}"
  local got
  got=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$url" || echo "000")
  if [ "$got" = "$want" ]; then
    echo "  ✓  $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗  $label  →  got HTTP $got, want $want"
    echo "     $url"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "══════════════════════════════════════════════"
echo "  Halo post-deploy verification"
echo "  $(date -u '+%Y-%m-%dT%H:%M:%SZ')   target: $BASE"
echo "══════════════════════════════════════════════"
echo ""
echo "── Core pages ──────────────────────────────"

# Login renders without auth
check "login page"   "$BASE/login"

# Root redirects to login when unauthenticated
ROOT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 --no-location "$BASE/" || echo "000")
if [ "$ROOT_STATUS" = "200" ] || [ "$ROOT_STATUS" = "307" ] || [ "$ROOT_STATUS" = "302" ]; then
  echo "  ✓  root redirect ($ROOT_STATUS)"
  PASS=$((PASS + 1))
else
  echo "  ✗  root redirect  →  got $ROOT_STATUS  ($BASE/)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "── Static asset serving (most critical) ────"

# THE most common failure mode: .next/static not copied into standalone.
# If this fails, every page will show 'This page couldn't load'.
STANDALONE_CHUNKS=".next/standalone/.next/static/chunks"
if [ -d "$STANDALONE_CHUNKS" ]; then
  CHUNK=$(ls "$STANDALONE_CHUNKS"/*.js 2>/dev/null | head -1 | xargs basename 2>/dev/null || true)
  if [ -n "$CHUNK" ]; then
    check "JS chunk served  ($CHUNK)" "$BASE/_next/static/chunks/$CHUNK"
  else
    echo "  ✗  no .js files found in $STANDALONE_CHUNKS"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  ✗  $STANDALONE_CHUNKS does not exist"
  echo "     Fix: cp -r .next/static .next/standalone/.next/"
  FAIL=$((FAIL + 1))
fi

# Build manifest (also lives in standalone after copy)
BUILD_ID=$(cat .next/BUILD_ID 2>/dev/null || true)
if [ -n "$BUILD_ID" ]; then
  check "build manifest   (_buildManifest.js)" "$BASE/_next/static/${BUILD_ID}/_buildManifest.js"
fi

echo ""
echo "── Public assets ───────────────────────────"
check "favicon" "$BASE/favicon.ico"

echo ""
echo "── API layer ───────────────────────────────"
# Auth.js session endpoint — always reachable, returns {} when unauthenticated
check "auth/session endpoint" "$BASE/api/auth/session"

echo ""
echo "══════════════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
  echo "  RESULT: $FAIL check(s) FAILED  ($PASS passed)"
  echo ""
  echo "  Chunk 404 or missing standalone chunks?"
  echo "    cp -r .next/static .next/standalone/.next/"
  echo "    cp -r public       .next/standalone/"
  echo "    pm2 restart wacrm"
  echo ""
  echo "  'This page couldn't load' after the restart?"
  echo "    rm -rf .next && SKIP_TYPECHECK=1 npm run build"
  echo "    cp -r .next/static .next/standalone/.next/"
  echo "    cp -r public       .next/standalone/"
  echo "    pm2 restart wacrm"
  echo "══════════════════════════════════════════════"
  exit 1
fi
echo "  RESULT: all $PASS checks passed ✓"
echo "══════════════════════════════════════════════"
