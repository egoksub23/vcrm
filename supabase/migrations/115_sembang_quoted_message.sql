-- ============================================================
-- Sembang: structured "quote and reply" (replaces the text-splicing
-- version from earlier this session).
--
-- Quoting a specific earlier message previously worked by prepending an
-- italic markdown line ("_Replying to X: "..."_") into the SAME plain
-- `body` text as the reply itself — the quote and the reply were one
-- opaque string with no structural boundary, which is why it rendered
-- as one seamless paragraph with no visual separation between the
-- quoted excerpt and the actual reply.
--
-- This adds a real column, quoted_message_id, mirroring the existing
-- parent_message_id (099/101) pattern exactly: a nullable self-FK,
-- validated by the same sembang_messages_guard() trigger (must be a
-- real message in the SAME channel; immutable after insert), hydrated
-- server-side into its own `quotedPreview` the way parent_message_id
-- is hydrated into `parentPreview` (see hydrate-messages.ts). Unlike
-- parent_message_id, a quoted message is NOT required to be top-level
-- — quoting a thread reply is a normal, expected case.
--
-- Depends on: 098 (sembang_messages), 099/101 (sembang_messages_guard).
-- Idempotent — safe to run more than once.
-- ============================================================

ALTER TABLE public.sembang_messages
  ADD COLUMN IF NOT EXISTS quoted_message_id UUID REFERENCES public.sembang_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sembang_messages_quoted
  ON public.sembang_messages (quoted_message_id) WHERE quoted_message_id IS NOT NULL;

-- Extends the guard (101's version) with quoted_message_id validation
-- and immutability — same shape as the parent_message_id checks, minus
-- the "must be top-level" rule (quoting a reply is fine) and plus a
-- defensive self-reference check (unreachable in the normal client
-- flow — a message can't know its own id before it's created — but
-- cheap insurance against a direct/scripted insert).
CREATE OR REPLACE FUNCTION public.sembang_messages_guard()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_parent_channel UUID;
  v_parent_is_reply BOOLEAN;
  v_quoted_channel UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_message_id IS NOT NULL THEN
      SELECT channel_id, (parent_message_id IS NOT NULL)
        INTO v_parent_channel, v_parent_is_reply
        FROM public.sembang_messages WHERE id = NEW.parent_message_id;
      IF v_parent_channel IS NULL THEN
        RAISE EXCEPTION 'sembang_reply_parent_missing';
      END IF;
      IF v_parent_channel <> NEW.channel_id THEN
        RAISE EXCEPTION 'sembang_reply_parent_wrong_channel';
      END IF;
      IF v_parent_is_reply THEN
        RAISE EXCEPTION 'sembang_reply_parent_is_itself_a_reply';
      END IF;
    END IF;
    IF NEW.also_in_channel AND NEW.parent_message_id IS NULL THEN
      RAISE EXCEPTION 'sembang_also_in_channel_requires_a_reply';
    END IF;
    IF NEW.quoted_message_id IS NOT NULL THEN
      IF NEW.quoted_message_id = NEW.id THEN
        RAISE EXCEPTION 'sembang_quoted_message_is_itself';
      END IF;
      SELECT channel_id INTO v_quoted_channel
        FROM public.sembang_messages WHERE id = NEW.quoted_message_id;
      IF v_quoted_channel IS NULL THEN
        RAISE EXCEPTION 'sembang_quoted_message_missing';
      END IF;
      IF v_quoted_channel <> NEW.channel_id THEN
        RAISE EXCEPTION 'sembang_quoted_message_wrong_channel';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE'
  IF NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.parent_message_id IS DISTINCT FROM OLD.parent_message_id
     OR NEW.also_in_channel IS DISTINCT FROM OLD.also_in_channel
     OR NEW.quoted_message_id IS DISTINCT FROM OLD.quoted_message_id THEN
    RAISE EXCEPTION 'sembang_message_immutable_column_changed';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sembang_messages_guard() OWNER TO postgres;
-- Trigger attachment is unchanged (BEFORE INSERT OR UPDATE on sembang_messages).
