# Running with Docker

The repo ships a multi-stage `Dockerfile` (Next.js standalone output,
runs as a non-root user) and a `docker-compose.yml` with a single
`app` service. Supabase is external — point the app at your hosted
(or self-hosted) Supabase project via env vars; no database container
is included.

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

2. Build and start (the `--env-file` flag is required — Compose only
   reads `.env` by default for `${VAR}` substitution, and this project
   keeps its config in `.env.local`):

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `.env.local`).

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container, and `env_file`
> would inject it there — leaving the app on a port the mapping and
> the healthcheck don't target. Compose pins it to 3000 for that
> reason.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time**. They are passed as Docker build args by
  `docker-compose.yml`. If you change any of them, rebuild:
  `docker compose --env-file .env.local up --build -d`. This includes
  `NEXT_PUBLIC_APP_LOCALE` (`en | ko | pt | es`), so the UI language is
  fixed per image.
- Everything else (`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`,
  `META_APP_SECRET`, …) is read at **runtime** from `.env.local` via
  `env_file` and is never baked into the image — safe to change with
  just a container restart.

## Plain Docker (no Compose)

```bash
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key \
  -t wacrm .

docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 wacrm
```

## Notes

- Database migrations under `supabase/` are **not** run by the
  container — apply them with the Supabase CLI as described in the
  README.
- Received attachments are copied into the `chat-media` Supabase
  Storage bucket, because Meta deletes media roughly 30 days after it
  arrives and the copy is the only thing that outlives that. It grows
  with inbound volume, so it's worth watching your project's storage
  quota. Turn it off per account under Settings → WhatsApp →
  Attachment Storage; attachments received while it's off become
  unviewable once Meta drops them. Files over 16 MB (the bucket's
  limit) are never copied.
- Nothing inside the container is scheduled. Automation Wait steps, flow
  timeouts, SLA alerts, incident escalation, Jira sync, stuck-send recovery
  and mailbox renewals all need an external scheduler to call nine URLs with
  the shared secret in the `x-cron-secret` header (`AUTOMATION_CRON_SECRET`,
  see `.env.local.example`). Every job answers 503 until that variable is
  set. The full list, how often to call each, an example crontab, and how to
  check from the Platform page that they are running are in
  [automations-and-cron.md](automations-and-cron.md).

## Keeping the disk from filling

Each `docker compose up --build` leaves build layers behind, and they add up
(one server reached 25 GB of build cache). Clearing the cache is safe: the
next build just takes longer the first time. This does not touch volumes, so
no data is lost. Add it to root's crontab to run weekly:

```
0 4 * * 0  docker builder prune -af --filter until=168h >> /var/log/docker-prune.log 2>&1 && docker image prune -f >> /var/log/docker-prune.log 2>&1
```

Check usage any time with `df -h /` and `docker system df`.

## Doc Sign converter (Word to PDF)

Doc Sign turns an uploaded Word file into a PDF with LibreOffice, run inside the
[Gotenberg](https://gotenberg.dev) container defined in `docker-compose.yml` as `sign-converter`.
It is **off by default** and only starts when the `sign` profile is on. Without it, PDFs and images still
work and a Word upload says "Word conversion is not available right now. Upload a PDF instead."

Turn it on by adding two lines to `.env.local` on the server and redeploying as usual:

```
COMPOSE_PROFILES=sign
SIGN_CONVERTER_URL=http://sign-converter:3000
```

What to know:

- **It cannot reach the internet and has no published port.** It sits on a Docker network marked
  `internal`, shared only with the app, and the app is the only thing that talks to it. Uploaded Word
  files are untrusted, so the container is also read-only (apart from a temporary folder), has no extra
  privileges, and is limited to about 1 GB of memory, 1.5 CPUs and 256 processes.
- **Size.** The image is large (on the order of 1.5 GB) and peaks at several hundred MB of memory while it
  converts one file; it converts one at a time and gives up after 60 seconds. Measure on the real server
  (`docker stats sign-converter` during a conversion, and `docker system df`). It is part of the weekly
  cleanup described above.
- **Fonts.** Arial, Times New Roman and Courier New are matched by metric-compatible fonts, so most
  documents convert closely. A font it does not have is replaced and text can shift; the editor always
  shows the converted pages ("This is exactly what will be signed") and the sender can upload a PDF
  instead. Fonts the company uses can be added to a custom image later.
- **Health.** The Platform page shows whether the converter answers. From the server:
  `docker compose --env-file .env.local ps` should list `sign-converter` as `healthy`.
- **Not Chinese/Korean-ready.** The fonts Halo writes onto signed documents are Latin only; see
  `docs/sign-dependencies.md` and `SIGN_CJK_FONT_PATH`.
