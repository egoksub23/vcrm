# Deploying the Vircle Chat gateway on the VPS (chat.vircle.tech)

The gateway runs next to Halo on the same server, in its own containers (the gateway and its own Postgres),
started from its own compose file. **Halo's `docker-compose.yml` and your usual Halo redeploy command are not
touched.** Decisions behind this (3 Oct 2026): the gateway lives at `chat.vircle.tech`; one server for the
pilot, with its own database, moving to AWS with the rest later.

## 1. DNS

Create an `A` record `chat.vircle.tech` pointing at the VPS (`187.127.105.156`), the same address as
`crm.vircle.tech`.

## 2. The gateway's settings

On the server, in `/opt/wacrm`:

```bash
cp .env.gateway.example .env.gateway
nano .env.gateway
```

Add `PUBLIC_BASE_URL=https://chat.vircle.tech` (the file links in messages are built from it; without it photos and voice notes cannot be opened by the app or by Halo; if your `.env.gateway` was made before 3 Oct 2026, append it: `echo PUBLIC_BASE_URL=https://chat.vircle.tech >> .env.gateway`). Set `GATEWAY_DB_PASSWORD` to a long random string (`openssl rand -hex 24`) and `GATEWAY_ENCRYPTION_KEY` to
`openssl rand -hex 32`. **Keep a copy of the encryption key somewhere safe**: it encrypts the Halo signing
secret the gateway stores, and without it that secret has to be entered again. Leave `SIMULATOR_ENABLED=true`
and `PUSH_ADAPTER=mock` for the pilot.

## 3. Start it

```bash
ssh root@187.127.105.156 "cd /opt/wacrm && git pull origin main && docker compose -f docker-compose.gateway.yml --env-file .env.gateway up --build -d"
```

It listens on `127.0.0.1:8090` only. Check it:

```bash
ssh root@187.127.105.156 "curl -s http://127.0.0.1:8090/healthz"
```

## 4. TLS and WebSockets for chat.vircle.tech

A reverse proxy on the server must serve `https://chat.vircle.tech` and pass it to `127.0.0.1:8090`,
**including WebSocket upgrades** (the app connects to `wss://chat.vircle.tech/ws`). `crm.vircle.tech` is served
by **nginx** on this server (checked 3 Oct 2026), so use the nginx block below; Caddy is only an alternative.

Caddy (gets the certificate by itself):

```
chat.vircle.tech {
    reverse_proxy 127.0.0.1:8090
}
```

nginx: the site file is in the repo (`deploy/nginx/chat.vircle.tech.conf`); after `git pull` on the server, as root:

```bash
cp deploy/nginx/chat.vircle.tech.conf /etc/nginx/sites-available/chat.vircle.tech
ln -sf /etc/nginx/sites-available/chat.vircle.tech /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d chat.vircle.tech --redirect      # adds the certificate and the https listener
```

The same block, for reference:

```
server {
    server_name chat.vircle.tech;
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
```

If the server sits behind a tunnel or CDN (for example Cloudflare), make sure WebSockets are enabled for the
`chat.vircle.tech` hostname.

Check from anywhere: `https://chat.vircle.tech/healthz` should answer `{"ok":true,"connections":0}`.

## 5. Connect Halo to it

1. In Halo, **Settings, Channels, Vircle Chat**: enter `https://chat.vircle.tech` as the gateway address and
   press **Save and connect**. Halo shows the workspace key, the signing secret and the API token **once**:
   copy them.
2. On the server, register the workspace in the gateway (the secrets go through the environment, not the
   command line):

```bash
ssh root@187.127.105.156
cd /opt/wacrm
docker compose -f docker-compose.gateway.yml --env-file .env.gateway exec \
  -e HALO_SIGNING_SECRET='vcs_...' -e HALO_API_TOKEN='vct_...' gateway \
  node dist/cli.js create-workspace --key vcw_... --name "Vircle" \
  --halo-url https://crm.vircle.tech/api/vircle-chat/webhook
```

   It prints a **sessions key**: that is for the Vircle backend developer (it is what lets the backend ask for
   a chat session for a signed-in user). Keep it for them.
3. Back in Halo, press **Test connection**: it should say the gateway answered.
4. Press **Open simulator**. The page opens at `https://chat.vircle.tech/simulator`.

Other commands: `node dist/cli.js list-workspaces | update-workspace | rotate-sessions-key | outbox |
retry-failed` (see `gateway/README.md`). When Halo rotates a secret, run `update-workspace` with the new value.

## 6. The simulator

`https://chat.vircle.tech/simulator` is reachable only through the **Open simulator** button, which hands the
gateway a link that is valid for five minutes and works once, signed with the workspace's secret. Test users it
creates are named `... (sim)`, appear in Halo's inbox as Vircle Chat contacts, and **never cause a real push**,
whatever `PUSH_ADAPTER` is. Before a production launch set `SIMULATOR_ENABLED=false` and redeploy.

## 7. Backups and logs

The database is the `gateway-db` volume. A nightly dump:

```bash
docker compose -f docker-compose.gateway.yml exec -T gateway-db pg_dump -U gateway gateway | gzip > /opt/backups/gateway-$(date +%F).sql.gz
```

(Add it to cron and keep a week; a fuller backup and restore runbook comes with work package 7.)
Logs: `docker compose -f docker-compose.gateway.yml logs -f gateway`.

## 8. Update later

Same command as step 3. Migrations run by themselves when the gateway starts. The simulator and the app
reconnect after a restart (connections are closed with a "service restart" code, and clients resume).
