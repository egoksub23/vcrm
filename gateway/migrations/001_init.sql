-- Vircle Chat gateway: initial schema (docs/vircle-chat-gateway-scope.md, work package 1.2).
--
-- A workspace is one Halo workspace's connection. Users and conversations belong to a workspace;
-- there is one conversation per user (docs/vircle-chat-contract.md, section 6). Messages carry a
-- per-conversation sequence number. Everything the gateway must tell Halo is written to
-- `outbox_events` in the SAME transaction as the change it describes, so a crash never loses an event.

CREATE TABLE workspaces (
  id                       TEXT PRIMARY KEY,
  workspace_key            TEXT NOT NULL UNIQUE,           -- the "vcw_..." key Halo generated
  name                     TEXT NOT NULL,
  halo_webhook_url         TEXT NOT NULL,                  -- where signed events go
  halo_signing_secret_enc  TEXT NOT NULL,                  -- encrypted: needed in plain form to sign
  halo_api_token_hash      TEXT NOT NULL UNIQUE,           -- sha256 of the bearer Halo presents
  sessions_key_hash        TEXT NOT NULL UNIQUE,           -- sha256 of the key the Vircle backend presents
  push_settings            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wallet_id     TEXT NOT NULL,
  name          TEXT,
  phone         TEXT,
  email         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, wallet_id)
);

CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  last_seq      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id                 TEXT PRIMARY KEY,                    -- the "m_..." server id
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  direction          TEXT NOT NULL CHECK (direction IN ('in', 'out')),   -- in: from the user; out: from Halo
  type               TEXT NOT NULL CHECK (type IN ('text', 'image', 'video', 'audio', 'document')),
  text               TEXT,
  media              JSONB,
  sender_name        TEXT,
  client_id          TEXT,                                -- the app's id for a send (idempotency)
  idempotency_key    TEXT,                                -- Halo's key for a send (idempotency)
  status             TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at       TIMESTAMPTZ,
  read_at            TIMESTAMPTZ,
  UNIQUE (conversation_id, seq)
);
CREATE UNIQUE INDEX messages_client_id_idx ON messages (conversation_id, client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX messages_idempotency_idx ON messages (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Events for Halo (transactional outbox). `dispatched_at` stays NULL until Halo accepted it.
CREATE TABLE outbox_events (
  id             TEXT PRIMARY KEY,                        -- the contract's event_id
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,                           -- message.inbound | message.receipt
  payload        JSONB NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at  TIMESTAMPTZ
);
CREATE INDEX outbox_pending_idx ON outbox_events (workspace_id, created_at) WHERE dispatched_at IS NULL;
