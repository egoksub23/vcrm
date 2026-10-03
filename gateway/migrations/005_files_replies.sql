-- Contract 1.2 (docs/vircle-chat-contract.md): files, replies, and ticks back to the app.
--
-- files          the bytes of every image, video, voice note and document that passes through, in either
--                direction. An app upload starts as a `pending` slot (a signed address the app PUTs the bytes
--                to) and becomes `ready` when the bytes arrive; a file from Halo is stored `ready` once the
--                gateway has fetched it. `attached_at` is set when a message uses the file (once). The bytes
--                live in Postgres for the pilot (16 MB cap, purged with the messages); the code reads and
--                writes them through one small class (src/files.ts), so moving them to object storage later
--                changes one file.
-- messages.reply_to   a snapshot of the message this one quotes (id, kind, text excerpt, who wrote it), so the
--                app can show the quote without a second lookup.

CREATE TABLE files (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  origin            TEXT NOT NULL CHECK (origin IN ('app', 'halo')),
  kind              TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document')),
  mime_type         TEXT NOT NULL,
  file_name         TEXT,
  size_bytes        INTEGER NOT NULL CHECK (size_bytes > 0),
  duration_seconds  INTEGER,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  data              BYTEA,
  attached_at       TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ NOT NULL,        -- a pending slot is good until then
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX files_pending_idx ON files (expires_at) WHERE status = 'pending';
CREATE INDEX files_conversation_idx ON files (conversation_id);

ALTER TABLE messages ADD COLUMN reply_to JSONB;
