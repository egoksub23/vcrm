-- ============================================================
-- Sembang: a grantable "manage" capability, separate from plain
-- access (menu.sembang).
--
-- Today every "acts like an admin" branch in Sembang's RLS (see
-- migrations 098-107) is hardcoded to public.is_account_member(...,
-- 'admin') — literally the account role, not a capability. That
-- means the only way to let someone see into every channel (private
-- ones included), rename/archive any channel, manage any channel's
-- membership, or moderate/remove any message account-wide is to make
-- them a full CRM Admin — which also hands them contacts, pipelines,
-- billing, member management, every other admin-gated surface in the
-- app. There was no way to designate a "Sembang admin" without that.
--
-- Fixes it with one new capability, 'sembang.manage' (Owner + Admin
-- by default, grantable down to Agent — same floor as menu.sembang
-- itself, since granting the manage capability without base access
-- would be meaningless). A new helper function centralizes the
-- "admin OR sembang.manage" check so every policy below reduces to a
-- one-line substitution instead of hand-duplicating the OR everywhere;
-- the account-admin path is unchanged (same is_account_member call,
-- same rank check), this only adds a second, non-role path to reach
-- the same effect.
--
-- Scope: every sembang_* table RLS policy that had an is_account_member
-- (..., 'admin') branch, across migrations 098/099/100/104/107.
-- list_sembang_channels_for_current_user (100) is untouched on
-- purpose — it already lists by plain channel membership only (no
-- admin bypass exists there today), so a plain CRM Admin and a
-- sembang.manage grantee behave identically in the sidebar: neither
-- sees a private channel they haven't joined without opening it
-- directly (browse/search), same as before this migration.
--
-- Depends on: 079 (capabilities), 098-107 (Sembang).
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Capability
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('sembang.manage', 'agent', 'database')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'sembang.manage'),
  ('admin', 'sembang.manage')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2. Helper: account admin OR the new capability.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_sembang_manager(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.is_account_member(p_account_id, 'admin')
      OR public.has_capability(p_account_id, 'sembang.manage');
$$;
ALTER FUNCTION public.is_sembang_manager(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_sembang_manager(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_sembang_manager(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. sembang_channels
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sembang_channels_select ON public.sembang_channels;
CREATE POLICY sembang_channels_select ON public.sembang_channels FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    NOT is_private
    OR public.is_sembang_channel_member(id)
    OR public.is_sembang_manager(account_id)
  )
);

DROP POLICY IF EXISTS sembang_channels_update ON public.sembang_channels;
CREATE POLICY sembang_channels_update ON public.sembang_channels FOR UPDATE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (public.is_sembang_channel_moderator(id) OR public.is_sembang_manager(account_id))
);

-- ------------------------------------------------------------
-- 4. sembang_channel_members
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sembang_channel_members_select ON public.sembang_channel_members;
CREATE POLICY sembang_channel_members_select ON public.sembang_channel_members FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    EXISTS (SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id AND NOT c.is_private)
    OR public.is_sembang_channel_member(channel_id)
    OR public.is_sembang_manager(account_id)
  )
);

DROP POLICY IF EXISTS sembang_channel_members_insert ON public.sembang_channel_members;
CREATE POLICY sembang_channel_members_insert ON public.sembang_channel_members FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id AND c.account_id = account_id)
  AND public.has_capability(account_id, 'menu.sembang')
  AND (
    (
      user_id = auth.uid()
      AND EXISTS (SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id AND NOT c.is_private)
    )
    OR public.is_sembang_channel_moderator(channel_id)
    OR public.is_sembang_manager(account_id)
  )
);

DROP POLICY IF EXISTS sembang_channel_members_delete ON public.sembang_channel_members;
CREATE POLICY sembang_channel_members_delete ON public.sembang_channel_members FOR DELETE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    user_id = auth.uid()
    OR public.is_sembang_channel_moderator(channel_id)
    OR public.is_sembang_manager(account_id)
  )
);

-- ------------------------------------------------------------
-- 5. sembang_messages (select + the DM-aware moderate policy from 100)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sembang_messages_select ON public.sembang_messages;
CREATE POLICY sembang_messages_select ON public.sembang_messages FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_channels c
    WHERE c.id = channel_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_sembang_manager(c.account_id))
  )
);

DROP POLICY IF EXISTS sembang_messages_moderate ON public.sembang_messages;
CREATE POLICY sembang_messages_moderate ON public.sembang_messages FOR UPDATE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    (
      public.is_sembang_channel_moderator(channel_id)
      AND NOT EXISTS (SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id AND c.is_dm)
    )
    OR public.is_sembang_manager(account_id)
  )
);

-- ------------------------------------------------------------
-- 6. sembang_attachments
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sembang_attachments_select ON public.sembang_attachments;
CREATE POLICY sembang_attachments_select ON public.sembang_attachments FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_messages m
    JOIN public.sembang_channels c ON c.id = m.channel_id
    WHERE m.id = message_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_sembang_manager(c.account_id))
  )
);

-- ------------------------------------------------------------
-- 7. sembang_reactions
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sembang_reactions_select ON public.sembang_reactions;
CREATE POLICY sembang_reactions_select ON public.sembang_reactions FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_messages m
    JOIN public.sembang_channels c ON c.id = m.channel_id
    WHERE m.id = message_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_sembang_manager(c.account_id))
  )
);

-- ------------------------------------------------------------
-- 8. sembang_pins
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sembang_pins_select ON public.sembang_pins;
CREATE POLICY sembang_pins_select ON public.sembang_pins FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_sembang_manager(c.account_id))
  )
);

DROP POLICY IF EXISTS sembang_pins_delete ON public.sembang_pins;
CREATE POLICY sembang_pins_delete ON public.sembang_pins FOR DELETE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    pinned_by = auth.uid()
    OR public.is_sembang_channel_moderator(channel_id)
    OR public.is_sembang_manager(account_id)
  )
);

-- ------------------------------------------------------------
-- 9. sembang_tasks
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sembang_tasks_select ON public.sembang_tasks;
CREATE POLICY sembang_tasks_select ON public.sembang_tasks FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_sembang_manager(c.account_id))
  )
);

DROP POLICY IF EXISTS sembang_tasks_delete ON public.sembang_tasks;
CREATE POLICY sembang_tasks_delete ON public.sembang_tasks FOR DELETE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    created_by = auth.uid()
    OR public.is_sembang_channel_moderator(channel_id)
    OR public.is_sembang_manager(account_id)
  )
);

-- ------------------------------------------------------------
-- 10. sembang_stars (insert's visibility check only — select/delete
-- are already owner-only with no admin branch to widen)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sembang_stars_insert ON public.sembang_stars;
CREATE POLICY sembang_stars_insert ON public.sembang_stars FOR INSERT WITH CHECK (
  public.has_capability(account_id, 'menu.sembang')
  AND user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.sembang_messages m
    WHERE m.id = message_id AND m.account_id = account_id AND m.deleted_at IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM public.sembang_messages m
    JOIN public.sembang_channels c ON c.id = m.channel_id
    WHERE m.id = message_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_sembang_manager(c.account_id))
  )
);

-- ------------------------------------------------------------
-- 11. sembang_bookmarks
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sembang_bookmarks_select ON public.sembang_bookmarks;
CREATE POLICY sembang_bookmarks_select ON public.sembang_bookmarks FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_channels c WHERE c.id = channel_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_sembang_manager(c.account_id))
  )
);

DROP POLICY IF EXISTS sembang_bookmarks_delete ON public.sembang_bookmarks;
CREATE POLICY sembang_bookmarks_delete ON public.sembang_bookmarks FOR DELETE USING (
  public.has_capability(account_id, 'menu.sembang')
  AND (
    added_by = auth.uid()
    OR public.is_sembang_channel_moderator(channel_id)
    OR public.is_sembang_manager(account_id)
  )
);

-- ------------------------------------------------------------
-- 12. sembang_link_previews
-- ------------------------------------------------------------
DROP POLICY IF EXISTS sembang_link_previews_select ON public.sembang_link_previews;
CREATE POLICY sembang_link_previews_select ON public.sembang_link_previews FOR SELECT USING (
  public.has_capability(account_id, 'menu.sembang')
  AND EXISTS (
    SELECT 1 FROM public.sembang_messages m
    JOIN public.sembang_channels c ON c.id = m.channel_id
    WHERE m.id = message_id
      AND (NOT c.is_private OR public.is_sembang_channel_member(c.id) OR public.is_sembang_manager(c.account_id))
  )
);
