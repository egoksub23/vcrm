-- ============================================================
-- 092_widget_v2 — Web Widget v2 (identity levels, signed in-app identity,
-- possible-duplicate suggestions, enquiry form, read receipts)
--
-- What this migration does
--   1. web_widget_config: verification_mode (none | email_code |
--      whatsapp_code; only 'none' is implemented, the others are stored and
--      shown as "coming soon"), and the per-workspace in-app identity
--      secret: identity_secret_enc (AES-256-GCM ciphertext, made by the app;
--      never the plaintext), identity_secret_last4, identity_secret_rotated_at.
--   2. widget_visitors: identity_level (guest | claimed | verified),
--      identity_source (typed | signed_app | code), identity_verified_at.
--      Existing browsers that already carry a phone become 'claimed'
--      (that phone was typed, unverified); the rest stay 'guest'.
--   3. contact_merge_suggestions: an unverified web claim that matches two
--      different contacts never merges them; the pair is recorded here for
--      an agent to Merge or Dismiss. Read by account members, written only
--      through the API (service role).
--   4. widget_enquiries: the enquiry form submissions (with consent time).
--   5. A lower(email) lookup index on contacts, for the claim / token match.
--   6. Visitor -> agent read ticks: when an agent opens a conversation
--      (conversations.unread_count goes from >0 to 0) the visitor's web-widget
--      messages in it flip to 'read'. messages.status already allows
--      sent | delivered | read (migration 001); nothing to widen there.
--   7. The audit trigger on web_widget_config also names the two new secret /
--      mode columns (names only, never a value).
--
-- The chat-media bucket is NOT touched (same size limit and allow-list).
-- Every function is SECURITY DEFINER with a fixed search_path and locked to
-- the service role / trigger use (as in 089). Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. web_widget_config
-- ------------------------------------------------------------
ALTER TABLE public.web_widget_config
  ADD COLUMN IF NOT EXISTS verification_mode          TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS identity_secret_enc        TEXT,
  ADD COLUMN IF NOT EXISTS identity_secret_last4      TEXT,
  ADD COLUMN IF NOT EXISTS identity_secret_rotated_at TIMESTAMPTZ;

ALTER TABLE public.web_widget_config DROP CONSTRAINT IF EXISTS web_widget_config_verification_mode_check;
ALTER TABLE public.web_widget_config ADD CONSTRAINT web_widget_config_verification_mode_check
  CHECK (verification_mode IN ('none', 'email_code', 'whatsapp_code'));

COMMENT ON COLUMN public.web_widget_config.identity_secret_enc IS
  'AES-256-GCM ciphertext (app ENCRYPTION_KEY) of the workspace secret that signs in-app identity tokens. Never selected by the settings screen; the plaintext is shown once on generate / rotate.';

-- ------------------------------------------------------------
-- 2. widget_visitors
-- ------------------------------------------------------------
ALTER TABLE public.widget_visitors
  ADD COLUMN IF NOT EXISTS identity_level       TEXT NOT NULL DEFAULT 'guest',
  ADD COLUMN IF NOT EXISTS identity_source      TEXT,
  ADD COLUMN IF NOT EXISTS identity_verified_at TIMESTAMPTZ;

ALTER TABLE public.widget_visitors DROP CONSTRAINT IF EXISTS widget_visitors_identity_level_check;
ALTER TABLE public.widget_visitors ADD CONSTRAINT widget_visitors_identity_level_check
  CHECK (identity_level IN ('guest', 'claimed', 'verified'));
ALTER TABLE public.widget_visitors DROP CONSTRAINT IF EXISTS widget_visitors_identity_source_check;
ALTER TABLE public.widget_visitors ADD CONSTRAINT widget_visitors_identity_source_check
  CHECK (identity_source IS NULL OR identity_source IN ('typed', 'signed_app', 'code'));

-- Before v2 a browser either typed a phone or supplied an (unsigned) one:
-- either way nothing was proven, so an existing browser with a phone is
-- 'claimed'. Only guests are touched, so a re-run changes nothing.
UPDATE public.widget_visitors wv
   SET identity_level = 'claimed',
       identity_source = COALESCE(wv.identity_source, 'typed')
  FROM public.contacts c
 WHERE c.id = wv.contact_id
   AND wv.identity_level = 'guest'
   AND COALESCE(c.phone, '') <> '';

-- ------------------------------------------------------------
-- 3. contact_merge_suggestions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_merge_suggestions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- A is the contact the visitor was attached to (the phone match); B is the
  -- other candidate. Merging keeps A and folds B into it.
  contact_a_id  UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  contact_b_id  UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  source        TEXT NOT NULL DEFAULT 'web_widget',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'merged', 'dismissed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at   TIMESTAMPTZ,
  CHECK (contact_a_id <> contact_b_id)
);

-- One row per unordered pair, whatever its status: a dismissed pair is never
-- re-suggested. (Merging deletes the folded contact, which removes its rows
-- here by cascade.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_merge_suggestions_pair
  ON public.contact_merge_suggestions (account_id, LEAST(contact_a_id, contact_b_id), GREATEST(contact_a_id, contact_b_id));
CREATE INDEX IF NOT EXISTS idx_contact_merge_suggestions_a
  ON public.contact_merge_suggestions (contact_a_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_contact_merge_suggestions_b
  ON public.contact_merge_suggestions (contact_b_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_contact_merge_suggestions_account
  ON public.contact_merge_suggestions (account_id, status, created_at DESC);

ALTER TABLE public.contact_merge_suggestions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_merge_suggestions_select ON public.contact_merge_suggestions;
CREATE POLICY contact_merge_suggestions_select ON public.contact_merge_suggestions
  FOR SELECT USING (is_account_member(account_id));
-- No INSERT / UPDATE / DELETE policy: every write goes through the API
-- (service role), which checks the 'contacts.merge' capability.
REVOKE INSERT, UPDATE, DELETE ON public.contact_merge_suggestions FROM anon, authenticated;

-- ------------------------------------------------------------
-- 4. widget_enquiries
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.widget_enquiries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id        UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id   UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  -- The browser (anonymous auth uid) that sent it. No FK: it can outlive the session row.
  widget_visitor_id UUID,
  name              TEXT,
  phone             TEXT,
  email             TEXT,
  role              TEXT NOT NULL CHECK (role IN ('parent', 'school', 'merchant', 'other')),
  message           TEXT NOT NULL,
  locale            TEXT,
  consent_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_widget_enquiries_account
  ON public.widget_enquiries (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_widget_enquiries_contact
  ON public.widget_enquiries (contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE public.widget_enquiries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS widget_enquiries_select ON public.widget_enquiries;
CREATE POLICY widget_enquiries_select ON public.widget_enquiries
  FOR SELECT USING (is_account_member(account_id));
REVOKE INSERT, UPDATE, DELETE ON public.widget_enquiries FROM anon, authenticated;

-- ------------------------------------------------------------
-- 5. Case-insensitive email lookup on contacts
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_contacts_account_email_lower
  ON public.contacts (account_id, lower(email))
  WHERE email IS NOT NULL AND email <> '';

-- ------------------------------------------------------------
-- 6. Read ticks for the visitor's own messages
-- ------------------------------------------------------------
-- An agent opening a conversation resets unread_count to 0 (the inbox does
-- that from the browser, and bulk "mark as read" does too). When the count
-- goes from something to zero, the visitor's web-widget messages in it are
-- 'read'. The widget subscribes to UPDATEs on its own messages and shows
-- the ticks. Runs as the function owner: the agent doing the read does not
-- (and should not need to) have UPDATE on customer messages.
CREATE OR REPLACE FUNCTION public.widget_customer_messages_read()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.messages
     SET status = 'read'
   WHERE conversation_id = NEW.id
     AND sender_type = 'customer'
     AND channel_type = 'web_widget'
     AND status IN ('sent', 'delivered');
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Ticks are cosmetic: never block the agent marking a chat read.
  RAISE WARNING 'widget_customer_messages_read failed for %: %', NEW.id, SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.widget_customer_messages_read() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.widget_customer_messages_read() TO service_role;

DROP TRIGGER IF EXISTS conversations_widget_read_ticks ON public.conversations;
CREATE TRIGGER conversations_widget_read_ticks
  AFTER UPDATE OF unread_count ON public.conversations
  FOR EACH ROW
  WHEN (COALESCE(OLD.unread_count, 0) > 0 AND COALESCE(NEW.unread_count, 0) = 0)
  EXECUTE FUNCTION public.widget_customer_messages_read();

-- ------------------------------------------------------------
-- 7. Audit: names only, never a value (082's rule for secrets)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS audit_row_change ON public.web_widget_config;
CREATE TRIGGER audit_row_change
  AFTER INSERT OR UPDATE OR DELETE ON public.web_widget_config
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(
    'channel_config', '=Web chat widget', '',
    'widget_token,name,welcome_message,primary_color,avatar_url,position,allowed_origins,enabled,verification_mode,identity_secret_enc',
    '', 'user_id');
