-- ============================================================
-- 130_tenant_isolation_hotfix.sql
--
-- Tenant-isolation hardening found by the multi-tenancy audit. None of
-- this is new feature work; every item closes a path by which one
-- tenant's data, or an anonymous widget visitor, could reach another
-- tenant's rows. Applies cleanly on top of 129 and is idempotent.
--
--   1. profiles: no client may INSERT a profile row. 017's
--      `profiles_insert` policy only checked `auth.uid() = user_id`, so
--      any signed-in user without a profile row (an anonymous chat-widget
--      visitor is exactly that: handle_new_user cannot build a profile
--      for a user with no email) could insert one into ANY account with
--      ANY role, including 'owner'. The only legitimate writers are
--      handle_new_user and the membership RPCs, all SECURITY DEFINER.
--   2. profiles.custom_role_id: 034's guard only covered account_role and
--      account_id, so a member could point their own custom_role_id at
--      any role. It is now guarded the same way, validated against the
--      profile's own account for every writer, and cleared when the
--      member leaves the account or becomes owner (a stale role from a
--      previous account was kept before).
--   3. Cross-tenant SECURITY DEFINER functions (agent assignment,
--      duplicate merge, incident escalation recompute) were executable
--      by anon/authenticated and take an account/team id as an argument
--      with no membership check. Only service_role and the other
--      DEFINER functions that call them need EXECUTE.
--   4. Storage: chat-media, flow-media and avatars each had an
--      unconditional SELECT policy on storage.objects (it applies to
--      anon), so anyone holding the public anon key could LIST every
--      tenant's `account-<uuid>/...` paths. Public buckets serve object
--      URLs without any policy, so those URLs keep working; the
--      replacement policies let a signed-in user list/read only their
--      own account's folder (own folder for avatars), which is all the
--      app needs for upsert/remove.
--   5. widget_visitors / conversations: same-account integrity triggers,
--      so a visitor or conversation can never reference a contact or
--      widget config of a different account, even if a route forgets to
--      check.
-- ============================================================

-- ------------------------------------------------------------
-- 1. profiles: block direct INSERT
-- ------------------------------------------------------------
DROP POLICY IF EXISTS profiles_insert ON public.profiles;

CREATE OR REPLACE FUNCTION public.block_direct_profile_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- current_user is the discriminator (same reasoning as 034): the
  -- sanctioned writers run as postgres (SECURITY DEFINER) or service_role.
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'profiles cannot be created directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.block_direct_profile_insert() OWNER TO postgres;

DROP TRIGGER IF EXISTS block_direct_profile_insert ON public.profiles;
CREATE TRIGGER block_direct_profile_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.block_direct_profile_insert();

-- ------------------------------------------------------------
-- 2. profiles: guard custom_role_id too
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_role_account UUID;
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role and account_id cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.custom_role_id IS DISTINCT FROM OLD.custom_role_id
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'custom_role_id cannot be changed directly; use set_member_custom_role'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A role belongs to one account. Leaving the account, or being promoted
  -- to owner (owners are not bound by a custom role), drops the old one
  -- unless the same statement deliberately assigns a new one.
  IF NEW.custom_role_id IS NOT NULL
     AND NEW.custom_role_id IS NOT DISTINCT FROM OLD.custom_role_id
     AND (NEW.account_id IS DISTINCT FROM OLD.account_id
          OR (NEW.account_role = 'owner' AND OLD.account_role IS DISTINCT FROM 'owner'))
  THEN
    NEW.custom_role_id := NULL;
  END IF;

  -- Whatever writes it, a custom role must belong to the profile's account.
  IF NEW.custom_role_id IS NOT NULL THEN
    SELECT account_id INTO v_role_account
      FROM public.account_roles WHERE id = NEW.custom_role_id;
    IF v_role_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'custom role does not belong to the member''s account'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enforce_profile_privilege_columns() OWNER TO postgres;

-- ------------------------------------------------------------
-- 3. Cross-tenant DEFINER functions: service_role only
-- ------------------------------------------------------------
-- Loops pg_proc instead of naming signatures so every overload is
-- covered. The callers that remain (the automation engine, which uses
-- the service-role client, and the 122 triggers, which are themselves
-- SECURITY DEFINER owned by postgres) keep working.
DO $revoke$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'pick_round_robin_agent',
         'pick_team_round_robin_member',
         'pick_least_loaded_agent',
         'pick_least_loaded_team_member',
         'merge_duplicate_contacts',
         'merge_duplicate_conversations',
         'incident_recompute_open_escalations'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END
$revoke$;

-- ------------------------------------------------------------
-- 4. Storage: stop anonymous listing of tenant folders
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;

DROP POLICY IF EXISTS "Members can read their account's chat media" ON storage.objects;
CREATE POLICY "Members can read their account's chat media"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can read their account's flow media" ON storage.objects;
CREATE POLICY "Members can read their account's flow media"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Users can read their own avatar files" ON storage.objects;
CREATE POLICY "Users can read their own avatar files"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- ------------------------------------------------------------
-- 5. Same-account integrity for widget visitors and conversations
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.widget_visitor_same_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.contacts WHERE id = NEW.contact_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'widget visitor contact belongs to a different account'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.web_widget_config WHERE id = NEW.widget_config_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'widget visitor config belongs to a different account'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.widget_visitor_same_account() OWNER TO postgres;

DROP TRIGGER IF EXISTS widget_visitor_same_account ON public.widget_visitors;
CREATE TRIGGER widget_visitor_same_account
  BEFORE INSERT OR UPDATE OF account_id, contact_id, widget_config_id ON public.widget_visitors
  FOR EACH ROW EXECUTE FUNCTION public.widget_visitor_same_account();

CREATE OR REPLACE FUNCTION public.conversation_contact_same_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.contacts WHERE id = NEW.contact_id AND account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'conversation contact belongs to a different account'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.conversation_contact_same_account() OWNER TO postgres;

DROP TRIGGER IF EXISTS conversation_contact_same_account ON public.conversations;
CREATE TRIGGER conversation_contact_same_account
  BEFORE INSERT OR UPDATE OF account_id, contact_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversation_contact_same_account();
