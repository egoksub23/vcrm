-- Migration 233: Sembang AI bot — sender_type column + nullable author_id
--
-- Bot messages are inserted by the server (service role), never by an
-- authenticated user. They have no auth.users entry, so author_id becomes
-- nullable. The new sender_type column distinguishes them from user posts.
--
-- Multi-tenancy: account_id is NOT NULL on sembang_messages already (098);
-- every query in the AI reply path must include an account_id filter.

-- ----------------------------------------------------------------
-- 1. sender_type: 'user' (default, existing rows) | 'bot' (AI reply)
-- ----------------------------------------------------------------
ALTER TABLE public.sembang_messages
  ADD COLUMN IF NOT EXISTS sender_type TEXT NOT NULL DEFAULT 'user'
  CONSTRAINT sembang_messages_sender_type_check CHECK (sender_type IN ('user', 'bot'));

-- ----------------------------------------------------------------
-- 2. author_id: allow NULL for bot rows (no auth.users entry)
-- ----------------------------------------------------------------
ALTER TABLE public.sembang_messages
  ALTER COLUMN author_id DROP NOT NULL;

-- ----------------------------------------------------------------
-- 3. Update the INSERT RLS policy so the server-side check still
--    allows service-role inserts (bypasses RLS anyway) but tightens
--    the client-side rule: clients must supply their own uid as
--    author and may only post sender_type='user'.
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS sembang_messages_insert ON public.sembang_messages;
CREATE POLICY sembang_messages_insert ON public.sembang_messages FOR INSERT WITH CHECK (
  public.has_capability(account_id, 'menu.sembang')
  AND author_id = auth.uid()
  AND sender_type = 'user'
  AND public.is_sembang_channel_member(channel_id)
);
