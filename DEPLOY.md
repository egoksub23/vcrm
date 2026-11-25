# Halo — Deployment & Verification Rules

> **Every Claude session reads this file.** These rules exist because production
> has been broken multiple times by incomplete deploy commands. Follow them exactly.

---

## Production environment

| Item | Value |
|---|---|
| VPS | `root@187.127.105.156` |
| App dir | `/opt/wacrm` |
| Process manager | pm2, name `wacrm`, id 3 |
| Runtime | `node .next/standalone/server.js` (standalone Next.js) |
| Domain | `halo.vircle.tech` |
| Database | Docker container `wacrm-postgres-1` on `127.0.0.1:5432` |

---

## Deploy commands — use the scripts, never bare commands

### Full deploy (new commits to push)

```bash
# 1. Push commits locally first
git push origin main

# 2. SSH to the VPS and run the deploy script
ssh root@187.127.105.156 "cd /opt/wacrm && bash scripts/deploy.sh"
```

### Quick rebuild (already on the right code, just need a fresh build)

```bash
ssh root@187.127.105.156 "cd /opt/wacrm && bash scripts/rebuild.sh"
```

### Verify only (check the running server is healthy)

```bash
ssh root@187.127.105.156 "cd /opt/wacrm && bash scripts/verify.sh"
```

---

## Why scripts — what breaks when you use bare commands

The standalone Next.js server (`server.js`) looks for static JS/CSS chunks in
`.next/standalone/.next/static/`, NOT in `.next/static/`. The build only populates
`.next/static/`. Without the copy step, every page shows "This page couldn't load"
and all `/_next/static/chunks/*.js` requests return 404.

**This exact failure broke production on 2026-11-25 and took ~6 hours to diagnose.**

The scripts enforce the correct sequence every time:
1. `rm -rf .next` — clear stale build
2. `SKIP_TYPECHECK=1 npm run build` — build
3. `cp -r .next/static .next/standalone/.next/` — copy chunks ← **the step that always gets missed**
4. `cp -r public .next/standalone/` — copy public assets
5. `set -a && . .env.local && set +a && pm2 restart wacrm --update-env && pm2 save`
6. `bash scripts/verify.sh` — confirm it works

**Never run steps 2–5 individually. Always use the scripts.**

---

## Checklist — Claude must follow this after every code change

### Before pushing

- [ ] Does the change touch any file imported by settings/page.tsx?
      If yes: settings is high-risk — test it explicitly after deploy.
- [ ] Does the change add a new server package? If yes: add it to
      `serverExternalPackages` in `next.config.ts`.
- [ ] Does the change add a new migration? If yes: apply it with
      `cat supabase/migrations/NNN.sql | docker exec -i wacrm-postgres-1 psql -U wacrm -d wacrm`
      **before** restarting pm2.

### After every deploy

Run `scripts/verify.sh` and confirm all checks pass. Then manually test
the specific page(s) changed in the browser at `https://halo.vircle.tech`.

**Pages to test after any rebuild (not just changed pages):**
- [ ] `/login` — loads without JS errors
- [ ] `/dashboard` — loads, shows stats
- [ ] `/inbox` — loads, channel icon visible
- [ ] `/settings` — loads, rail links work (settings is chunk-heavy and the
      most common victim of a bad deploy)

---

## Failure modes and fixes

### "This page couldn't load" on some pages (e.g. settings) but not all

Cause: `.next/static` was not copied into `.next/standalone/.next/static/`.
Some pages need chunks that others don't, so only those pages fail.

Fix:
```bash
cp -r .next/static .next/standalone/.next/
cp -r public .next/standalone/
pm2 restart wacrm
bash scripts/verify.sh
```

### React Client Manifest error in pm2 logs

```
Error: Could not find the module "...#ViewportBoundary" in the React Client Manifest
```

Cause: stale `.next` cache from a previous build conflicting with current code.

Fix: clean build via `bash scripts/rebuild.sh` (it always starts with `rm -rf .next`).

### Environment variables wiped after pm2 restart (login stops working)

Cause: `pm2 restart --update-env` replaces pm2's saved env with the current shell's
env. A bare shell has no secrets.

Fix: always source `.env.local` before restarting:
```bash
set -a && . .env.local && set +a && pm2 restart wacrm --update-env && pm2 save
```
The scripts do this automatically.

### 502 Bad Gateway immediately after restart

Cause: pm2 restarted but Next.js hasn't finished starting yet (takes ~5–10 s).
Not an error — wait and retry. `verify.sh` sleeps 10 s before checking.

### Knowledge base reindex fails with `{success: false, error: '[object Object]'}`

Cause: either the embeddings key is corrupt, or (on FTS-only prod) the
`ai_knowledge_chunks` table is missing the `embedding` column and the insert tried
to include it. Fixed in commit d8fcecc8 — the row construction now omits
`embedding` when no embeddings API key is configured.

---

## Environment constraints

| Constraint | Detail |
|---|---|
| `SKIP_TYPECHECK=1` | Mandatory on VPS — full TSC needs ~2 GB RAM, VPS has less |
| `npm ci --omit=dev` | Skips devDependencies (vitest etc.) — build still works |
| `output: 'standalone'` | Build creates `.next/standalone/server.js` — static assets must be manually copied in |
| Node version | 20.20.2 on VPS (npm warns about engine mismatch — non-fatal) |
| pgvector | NOT installed on prod DB — knowledge base runs FTS-only (no embeddings) |

---

## Migration workflow

Apply before restarting pm2 (never after — the new code may expect the new schema):

```bash
cat supabase/migrations/NNN_name.sql | docker exec -i wacrm-postgres-1 psql -U wacrm -d wacrm
```

The `storage.buckets` error that appears is harmless.

---

## pm2 recovery (if process ever disappears)

```bash
pm2 start /opt/wacrm/.next/standalone/server.js --name wacrm --cwd /opt/wacrm
set -a && . /opt/wacrm/.env.local && set +a
pm2 restart wacrm --update-env
pm2 save
pm2 startup  # re-register systemd hook
```
