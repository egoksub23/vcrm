# The UAT environment

A second, separate copy of Halo and the Vircle chat gateway for testing before anything reaches production. **Draft** (25 Oct 2026): the steps are written from this repository's own deploy notes and have not yet been run on the new server. Items marked **To confirm** are things we have not checked.

| | Production | UAT |
|---|---|---|
| Server | `187.127.105.156` | `201.18.208.23` |
| Halo | `https://halo.vircle.tech` | `https://uat-halo.vircle.tech` *(suggested name)* |
| Chat gateway | `https://chat.vircle.tech` | `https://uat-chat.vircle.tech` *(suggested name)* |
| Database | the Supabase project | a **separate Supabase project**, `uat-vircle-crm` (ref `fnikdmpotwwdbmklqmut`, Sydney): its own database, URL and keys |
| App directory | `/opt/wacrm` | `/opt/wacrm` (the same, so every command in these notes works on both) |
| Vircle push API | `x-api-stage: prod` | `x-api-stage: uat` |

## 1. The rules

UAT must never act on production's outside world, and production must never be touched by UAT.

1. **Its own database.** Never point UAT at production's Supabase URL or keys. Use the UAT project's own URL, anon key and service-role key.
2. **Its own secrets.** A different `ENCRYPTION_KEY`, `AUTOMATION_CRON_SECRET`, gateway encryption key, gateway database password, metrics token and sessions key. Never copy production's.
3. **A different `ENCRYPTION_KEY` is also the safety catch for a data copy.** If data is ever copied from production, the channel secrets in it (Meta, Gmail, Jira, the chat gateway connection) are encrypted under production's key. UAT cannot decrypt them, so it cannot send real WhatsApp messages or reach real services with them. Keep it that way.
4. **Fake data only.** Production has not gone live, so what it holds today is test data, but no real KYC records, children's ID data or real customers' details may ever be copied into UAT.
5. **Not public.** Put UAT behind a login, an IP allow-list, or at least `X-Robots-Tag: noindex`, so it cannot be found or used by anyone else.
6. **UAT first, production second.** Every migration and every release runs on UAT, then on production, the same commit.

## 2. Set it up, in this order

### 2.1 DNS

Two `A` records pointing at `201.18.208.23`: `uat-halo.vircle.tech` and `uat-chat.vircle.tech`.

### 2.2 The server (Ubuntu, as root)

```bash
apt update && apt -y upgrade
apt -y install nginx certbot python3-certbot-nginx git ufw curl
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
curl -fsSL https://get.docker.com | sh
docker compose version
```

The swap file is a safety net for the build: compiling Halo needs several GB. If the build is killed, the server is too small; give it more memory or build the image elsewhere.

### 2.3 The code

The repository is private, so the server needs a read-only **deploy key**: on the server `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''`, add the public key (`cat ~/.ssh/id_ed25519.pub`) in GitHub under the repository's **Settings, Deploy keys** (read access only), then:

```bash
git clone git@github.com:egoksub23/vcrm.git /opt/wacrm
```

### 2.4 The database: the `uat-vircle-crm` Supabase project

1. The project exists (ref `fnikdmpotwwdbmklqmut`, Sydney). **A project on Supabase's free plan pauses itself after a period of inactivity** and then has to be restored in the dashboard before anything can reach it: if UAT suddenly stops answering, check that first, and consider a plan that does not pause it.
2. Its three values (URL, anon key, service-role key) go straight into the UAT server's `.env.local` and nowhere else.
3. **Before the first push**, on the new project run once: `supabase db query --linked 'alter database postgres set search_path = "$user", public, extensions'`. Without it migration 001 stops on `uuid_generate_v4()`: the temporary login role the push uses does not inherit the `postgres` role's search path. (Done on `uat-vircle-crm` on 25 Oct 2026.)
4. A new project is empty. Apply every migration in order from this repository, from a **clean copy** of the repository at the commit that is to go to UAT, linked to the UAT ref (`supabase link --project-ref fnikdmpotwwdbmklqmut`, then `supabase db push --linked`). Never relink the working copy that production's migrations are applied from. Check with `supabase migration list` before pushing.
5. In the project's own dashboard set what production has under **Authentication**: the site URL and redirect URLs (`https://uat-halo.vircle.tech`), and the email sender, if used. Settings are per project.

**State on 25 Oct 2026:** all 194 migrations are applied to `uat-vircle-crm`; its schema matches production (177 tables, 385 policies, 278 triggers, 7 buckets, 75 capabilities; the one public function production has extra is an old `uuid_generate_v4()` wrapper that UAT does not need), and the rolled-back verify scripts 183, 184, 185, 186, 188, 189, 192, 193 and 194 pass on it. Still to do: the Authentication settings, the keys into the server's `.env.local`, and the server steps (2.2 to 2.9).

### 2.5 The settings files

On the server, in `/opt/wacrm`:

```bash
cp .env.local.example .env.local
cp .env.gateway.example .env.gateway
```

`.env.local` (Halo). Values that differ from production:

| Setting | UAT value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | the branch's |
| `NEXT_PUBLIC_SITE_URL` | `https://uat-halo.vircle.tech` |
| `ENCRYPTION_KEY` | a **new** one: `openssl rand -hex 32`. Keep a copy somewhere safe |
| `AUTOMATION_CRON_SECRET` | a new one |
| `META_APP_SECRET`, `META_APP_ID` | the UAT / test app's, or leave unset (no WhatsApp in UAT until you want it) |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | a sandbox key, or leave unset (no real emails) |
| `KYC_DOC_API_BASE_URL`, `KYC_DOC_API_KEY` | the **UAT** doc-processor address and its key (never production's) |
| `BACK_OFFICE_USER_URL` | the test back office, if there is one, or leave unset |
| Jira, Google, Microsoft 365, TikTok | leave unset |

`.env.gateway`:

| Setting | UAT value |
|---|---|
| `GATEWAY_DB_PASSWORD`, `GATEWAY_ENCRYPTION_KEY`, `METRICS_TOKEN` | new random values (`openssl rand -hex 32`) |
| `PUBLIC_BASE_URL` | `https://uat-chat.vircle.tech` |
| `SIMULATOR_ENABLED` | `true` (the simulator is a UAT tool) |
| `PUSH_ADAPTER` | `mock` first. When ready to test real alerts: `vircle`, with `PUSH_API_URL=https://apis-uat.vircle.com/airtable/send-mobile-alert`, `PUSH_API_STAGE=uat` and `PUSH_API_KEY` |

The push API key is Vircle's, held in your own file: add it with the stdin command used for production, never typed into chat.

### 2.6 Start both

```bash
cd /opt/wacrm
docker compose -f docker-compose.gateway.yml --env-file .env.gateway up --build -d
docker compose --env-file .env.local up --build -d
```

The first Halo build is cold and slow. Check: `curl -s http://127.0.0.1:8090/healthz` answers `{"ok":true,...}`, and `curl -sI http://127.0.0.1:3000` answers.

### 2.7 nginx and certificates

The gateway's site file is in the repository. Halo's is the standard proxy. On the server:

```bash
sed 's/chat.vircle.tech/uat-chat.vircle.tech/' deploy/nginx/chat.vircle.tech.conf > /etc/nginx/sites-available/uat-chat.vircle.tech
ln -sf /etc/nginx/sites-available/uat-chat.vircle.tech /etc/nginx/sites-enabled/
```

For Halo, a file `/etc/nginx/sites-available/uat-halo.vircle.tech` with:

```
server {
    server_name uat-halo.vircle.tech;
    client_max_body_size 25m;
    add_header X-Robots-Tag "noindex, nofollow" always;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**To confirm**: production's own nginx file for Halo (copy its upload size and timeouts into this one). Then:

```bash
ln -sf /etc/nginx/sites-available/uat-halo.vircle.tech /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d uat-halo.vircle.tech -d uat-chat.vircle.tech --redirect
```

### 2.8 Connect Halo to the UAT gateway

Exactly as production's section 5 in `docs/vircle-chat-gateway-deploy.md`, with the UAT addresses: in UAT Halo, **Settings, Channels, Vircle Chat**, enter `https://uat-chat.vircle.tech` and **Save and connect**; register the workspace on the UAT gateway (`node dist/cli.js create-workspace ...` inside its container). The app team's builds point at `https://uat-chat.vircle.tech` for their own testing.

### 2.9 The first sign-in

Sign up in UAT Halo to create the first workspace and owner. The platform feature flags (`compliance`, `kyc`, `vircle_chat`) are off for every new workspace: switch them on as a platform operator (**Platform**, the workspace, **Edit**).

## 3. Copying production into UAT (the owner's choice, because production has not gone live)

The reliable way to "replicate production" is the **code and the settings**, which this runbook does (the same commit, the same migrations, the same flags). A copy of production's **data** is optional, and only safe because production holds only test data today. If you do copy it:

1. Copy into the **UAT project** only, never the other way round.
2. UAT's different `ENCRYPTION_KEY` (rule 3) makes the copied channel secrets unreadable. After the copy, **disconnect or re-enter** each integration in UAT (WhatsApp, Gmail, Jira, the Vircle Chat connection, the push settings) with UAT's own values.
3. Turn off the automations and the scheduled jobs in the copied workspace until you mean to run them.
4. Never run the cron lines on UAT's server until those are checked.
5. Check for real people's details (customers, contacts) and delete what should not be there.

## 4. Every release, from now on

1. Merge to `main`.
2. On UAT: apply the new migration(s) to the **UAT project** first, then deploy (Halo and, if it changed, the gateway).
3. Test on UAT (section 5).
4. Only then apply the migration to production and deploy production, the **same commit**.

## 5. The smoke test after a deploy

1. `https://uat-halo.vircle.tech` loads, sign-in works.
2. `https://uat-chat.vircle.tech/healthz` answers `{"ok":true,...}`.
3. Send a message from UAT Halo to a UAT test chat user: it arrives; reply from the simulator: it appears in Halo.
4. Open **Compliance**, raise a **Transaction fraud review**: the type, the fields, the file attach and the checklist work.
5. Open **KYC review** (UAT doc-processor): the list loads on **Needs review**.
6. With `PUSH_ADAPTER=vircle` and stage `uat`: a message to a closed app raises a real alert on a test phone.

## 6. Not decided yet

- The names `uat-halo` and `uat-chat` are suggestions: any addresses work if both nginx files, `NEXT_PUBLIC_SITE_URL` and `PUBLIC_BASE_URL` agree.
- Whether UAT gets its own test WhatsApp number, test email sender and back office.
- Whether the build moves to a CI pipeline so neither server compiles (see "Keeping the disk from filling" in `docker.md`).
- Backups of the UAT gateway database (`deploy/gateway-backup.sh`), if it holds anything worth keeping.
