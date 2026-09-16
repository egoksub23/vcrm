-- ============================================================
-- 046_channels
--
-- Vircle CRM stops being WhatsApp-only. This migration lays the
-- multi-channel foundation for two features shipping together:
--   1. A "Channels" settings section (WhatsApp relocates there,
--      unchanged; other channel types get UI-only "coming soon"
--      entries with no backend yet).
--   2. An embeddable web-chat widget — a second, real inbound
--      channel with its own config, its own contact identity, and
--      an anonymous-visitor auth tier that today's schema has no
--      concept of at all.
--
-- What this migration does, in order:
--   1. Adds `conversations.channel_type` and widens the existing
--      one-conversation-per-(account,contact) dedup guarantee
--      (migration 036) to (account, contact, channel_type).
--   2. Adds `contacts.widget_visitor_id`, mirroring the
--      `wa_user_id` pattern from migration 040 exactly: `phone`
--      stays NOT NULL, a widget-only contact stores '' there.
--   3. Creates `web_widget_config` — one row per account, same
--      shape/RLS tier as `whatsapp_config` (admin+ write, member+
--      read via `is_account_member`).
--   4. Creates `widget_visitors` — maps a Supabase anonymous-auth
--      `auth.uid()` to a `contacts` row. No client-facing RLS
--      policy of its own; it exists so the new visitor-scoped
--      policies below have something to join through.
--   5. Adds additive SELECT-only RLS policies on `conversations` and
--      `messages` that let an anonymous widget visitor read *their
--      own* conversation only (so Supabase Realtime can deliver its
--      postgres_changes events to them) — a third tier alongside the
--      existing `is_account_member` dashboard policies, which are
--      untouched. Visitor-authored messages are written through the
--      service-role `/api/widget/message` route instead of a direct
--      client insert, so no INSERT policy is needed.
--
-- Requires Supabase Auth's "Allow anonymous sign-ins" to be enabled
-- on the project — the widget bundle calls
-- `supabase.auth.signInAnonymously()` and this migration's RLS
-- policies key off the resulting `auth.uid()`.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1) CONVERSATIONS — channel_type + widened dedup index
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel_type TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (channel_type IN ('whatsapp', 'web_widget'));

DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_channel
  ON conversations (account_id, contact_id, channel_type);

CREATE INDEX IF NOT EXISTS idx_conversations_channel_type
  ON conversations (account_id, channel_type);

-- ============================================================
-- 2) CONTACTS — widget visitor identity
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS widget_visitor_id UUID;

COMMENT ON COLUMN contacts.widget_visitor_id IS
  'Supabase anonymous-auth auth.uid() for a contact who first arrived via the web-chat widget. Mirrors wa_user_id (migration 040): phone stays NOT NULL and is '''' for widget-only contacts.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_widget_visitor_id
  ON contacts (account_id, widget_visitor_id)
  WHERE widget_visitor_id IS NOT NULL;

-- ============================================================
-- 3) WEB_WIDGET_CONFIG
-- ============================================================
CREATE TABLE IF NOT EXISTS web_widget_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  widget_token TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Website chat',
  welcome_message TEXT NOT NULL DEFAULT 'Hi there! How can we help?',
  primary_color TEXT NOT NULL DEFAULT '#3b82f6',
  avatar_url TEXT,
  position TEXT NOT NULL DEFAULT 'right' CHECK (position IN ('left', 'right')),
  allowed_origins TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id),
  UNIQUE(widget_token)
);

ALTER TABLE web_widget_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS web_widget_config_select ON web_widget_config;
DROP POLICY IF EXISTS web_widget_config_insert ON web_widget_config;
DROP POLICY IF EXISTS web_widget_config_update ON web_widget_config;
DROP POLICY IF EXISTS web_widget_config_delete ON web_widget_config;
CREATE POLICY web_widget_config_select ON web_widget_config FOR SELECT USING (is_account_member(account_id));
CREATE POLICY web_widget_config_insert ON web_widget_config FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY web_widget_config_update ON web_widget_config FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY web_widget_config_delete ON web_widget_config FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- 4) WIDGET_VISITORS
--
-- `id` IS the visitor's Supabase anonymous auth.uid() — not a
-- separate generated key. That's what lets the RLS policies below
-- join straight from `auth.uid()` to a contact/conversation without
-- a lookup table of its own.
-- ============================================================
CREATE TABLE IF NOT EXISTS widget_visitors (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  widget_config_id UUID NOT NULL REFERENCES web_widget_config(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_widget_visitors_contact ON widget_visitors(contact_id);

-- RLS enabled with NO policies for the anon/authenticated roles: only
-- the service-role route that mints these rows ever reads or writes
-- this table directly. It exists purely so policies on other tables
-- can join through it.
ALTER TABLE widget_visitors ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 5) VISITOR-SCOPED RLS — additive, third tier
--
-- A widget visitor's Supabase session is a real `auth.uid()` (from
-- anonymous sign-in), but they are never an `is_account_member` —
-- these policies are separate grants, not a relaxation of the
-- existing membership check. Postgres RLS policies are OR'd
-- together per command, so this can only ever add visibility, never
-- take any away from the dashboard's own policies.
-- ============================================================
DROP POLICY IF EXISTS conversations_widget_visitor_select ON conversations;
CREATE POLICY conversations_widget_visitor_select ON conversations FOR SELECT USING (
  channel_type = 'web_widget'
  AND EXISTS (
    SELECT 1 FROM widget_visitors wv
    WHERE wv.id = auth.uid() AND wv.contact_id = conversations.contact_id
  )
);

-- SELECT only — a visitor's own messages send through the public
-- POST /api/widget/message route (service role), not a direct client
-- insert, so the same request can also run automations/flows/AI-reply
-- dispatch synchronously (see send-message.ts / widget/message route).
-- No INSERT policy needed here as a result.
--
-- `is_internal IS NOT TRUE` is load-bearing: internal comments
-- (migration 045) are teammate-only by design, and without this
-- exclusion a visitor's own RLS-scoped SELECT — and the Realtime
-- postgres_changes feed it powers in the widget bundle — would leak
-- an agent's internal note straight to the customer.
DROP POLICY IF EXISTS messages_widget_visitor_select ON messages;
CREATE POLICY messages_widget_visitor_select ON messages FOR SELECT USING (
  is_internal IS NOT TRUE
  AND EXISTS (
    SELECT 1 FROM conversations c
    JOIN widget_visitors wv ON wv.contact_id = c.contact_id
    WHERE c.id = messages.conversation_id
      AND c.channel_type = 'web_widget'
      AND wv.id = auth.uid()
  )
);
