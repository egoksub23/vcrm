# syntax=docker/dockerfile:1

# ---------------------------------------------------------------
# Stage 1 — install dependencies (cached until package*.json change)
# ---------------------------------------------------------------
FROM node:24.22.1-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------
# Stage 2 — build
#
# NEXT_PUBLIC_* values are inlined into the client bundle at build
# time, so they must be provided as build args (docker-compose.yml
# forwards them from .env.local). Server-only secrets (service role
# key, ENCRYPTION_KEY, META_APP_SECRET, ...) are read at runtime and
# must NOT be baked into the image.
# ---------------------------------------------------------------
FROM node:24.22.1-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_APP_LOCALE=en
ARG NEXT_PUBLIC_APP_NAME
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_APP_LOCALE=$NEXT_PUBLIC_APP_LOCALE \
    NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME \
    NEXT_TELEMETRY_DISABLED=1 \
    SKIP_TYPECHECK=1

# The compiler's cache (.next/cache) lives in a BuildKit cache mount, so it survives from one deploy to the next: a rebuild after a small change
# recompiles only what changed (measured on a developer PC: 162 s cold, 44 s warm). The cache is not part of the image, so the image does not grow.
# `docker builder prune` clears it (the weekly job in docs/docker.md does); the next build is then cold once.
RUN --mount=type=cache,target=/app/.next/cache npm run build

# ---------------------------------------------------------------
# Stage 3 — minimal runtime (standalone output)
# ---------------------------------------------------------------
FROM node:24.22.1-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S nextjs && adduser -S nextjs -G nextjs

COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public
# User Guide pages (Markdown) are read from disk at runtime by /help.
COPY --from=builder --chown=nextjs:nextjs /app/content ./content
# Doc Sign's PDF engine reads its fonts, and the add-on files, from disk when it sends, seals or checks a document. A route is only traced for what it
# imports (next.config.ts lists these for /api/sign and /api/v1/sign), and a document is also sent by an automation, which runs inside other routes: so
# the folders are copied whole, and no route can run without its fonts.
COPY --from=builder --chown=nextjs:nextjs /app/src/lib/sign/pdf/assets ./src/lib/sign/pdf/assets
COPY --from=builder --chown=nextjs:nextjs /app/src/lib/sign/addons ./src/lib/sign/addons

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
