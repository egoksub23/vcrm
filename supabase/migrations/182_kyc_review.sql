-- ============================================================
-- 182_kyc_review.sql
--
-- KYC review, phase 1 (read-only). A staff screen under Incidents over Vircle's ID verification back end ("doc-processor"), which holds ID images and
-- validation records of CHILDREN. Halo stores none of that: the key to the back end and every call to it live on the server (env KYC_DOC_API_BASE_URL and
-- KYC_DOC_API_KEY), the image is fetched per view and streamed, never kept. What the database holds is the switch, the permissions and the access log:
--
--   1. Capabilities   menu.kyc (see the menu and the screen), kyc.view (open an ID image), kyc.reveal (read the masked values in full).
--                     Owner and Admin by default; every other role, and every custom role built on one, has none until an admin grants it.
--                     App tier (min grant: agent): the data is behind server routes, there is no table the browser reads with these.
--   2. The flag       platform feature `kyc`, OFF for every workspace that exists (an explicit false) and for every workspace made from now on
--                     (account_platform_seed writes it). Only the operator console can turn it on. The app also reads an absent key as OFF for this flag
--                     (src/lib/platform/features.ts DEFAULT_OFF_FEATURES), unlike every other flag, so a missing platform row can never switch it on.
--   3. kyc_access_log Who looked up which child's ID, listed validations, opened an image or revealed a value, and what happened. Written by the
--                     server (service role) for every lookup, list, image view, reveal and configuration error. Never holds a key, an image, a field
--                     value or an upstream response. Readable by the workspace's admins and owners only; no browser can write it; append-only (a
--                     trigger refuses every UPDATE, DELETE and TRUNCATE, with the one exception the audit log has: a workspace being purged by
--                     delete_workspace_data(), 153). It is NOT trimmed by any job. It is part of the workspace export (the export discovers every
--                     table with an account_id) and is removed with the workspace.
--
-- No new function is callable by a signed-in or signed-out user: the one trigger function is not SECURITY DEFINER, so supabase/ci/verify-guard-catalog.sql
-- needs no change. account_platform_seed() is replaced (it was already reviewed: a trigger).
--
-- Apply this migration BEFORE the code that goes with it is deployed. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Capabilities
-- ------------------------------------------------------------
INSERT INTO public.capability_catalogue (capability, min_grant_role, enforced_by) VALUES
  ('menu.kyc',   'agent', 'app'),
  ('kyc.view',   'agent', 'app'),
  ('kyc.reveal', 'agent', 'app')
ON CONFLICT (capability) DO UPDATE
  SET min_grant_role = EXCLUDED.min_grant_role,
      enforced_by    = EXCLUDED.enforced_by;

INSERT INTO public.role_capability_defaults (role, capability) VALUES
  ('owner', 'menu.kyc'),
  ('admin', 'menu.kyc'),
  ('owner', 'kyc.view'),
  ('admin', 'kyc.view'),
  ('owner', 'kyc.reveal'),
  ('admin', 'kyc.reveal')
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- 2. The platform flag: off everywhere until the operator turns it on
-- ------------------------------------------------------------
UPDATE public.account_platform
SET features = features || '{"kyc": false}'::jsonb
WHERE NOT (features ? 'kyc');

-- 157's seed with one more key. A workspace made from now on starts with KYC review off.
CREATE OR REPLACE FUNCTION public.account_platform_seed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.account_platform (account_id, features)
  VALUES (NEW.id,
          '{"incidents": false, "jira": false, "vircle_chat": false, "sign": false, "sign_merchant": false, "kyc": false}'::jsonb)
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block signup; readers treat a missing row as active/all-features (except kyc, which the app reads as off).
  RAISE WARNING 'account_platform_seed failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.account_platform_seed() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_platform_seed() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. The access log
--    No foreign key on the person: deleting a login must not touch a logged row (the same choice as sign_events).
--    friend_id is what the reviewer typed, trimmed (the app only lets [A-Za-z0-9._@:+-], 1 to 100 characters, through).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kyc_access_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id       UUID,
  action        TEXT NOT NULL CHECK (action IN ('lookup', 'list', 'view_image', 'reveal', 'config_error')),
  friend_id     TEXT CHECK (friend_id IS NULL OR length(friend_id) BETWEEN 1 AND 100),
  validation_id TEXT CHECK (validation_id IS NULL OR length(validation_id) BETWEEN 1 AND 200),
  outcome       TEXT NOT NULL CHECK (outcome IN ('ok', 'not_found', 'forbidden', 'error')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kyc_access_log_account_time_idx   ON public.kyc_access_log (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kyc_access_log_account_friend_idx ON public.kyc_access_log (account_id, friend_id);

ALTER TABLE public.kyc_access_log ENABLE ROW LEVEL SECURITY;

-- The browser may read (admins and owners of the workspace only) and nothing else: no INSERT, UPDATE or DELETE privilege and no policy for them.
REVOKE ALL ON public.kyc_access_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.kyc_access_log TO authenticated;

DROP POLICY IF EXISTS kyc_access_log_select ON public.kyc_access_log;
CREATE POLICY kyc_access_log_select ON public.kyc_access_log
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id, 'admin'::account_role_enum));

-- Append-only, with the one exception the audit log has (153): a workspace being purged by delete_workspace_data(), which sets
-- vircle.purge_account to its own id (only a database owner role can; the API roles are refused whatever they set). The workspace's
-- ON DELETE CASCADE runs as the table owner inside that function, so it passes the same check.
CREATE OR REPLACE FUNCTION public.kyc_access_log_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW'
     AND current_user NOT IN ('anon', 'authenticated', 'service_role')
     AND current_setting('vircle.purge_account', true) = OLD.account_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'kyc_access_log is append-only' USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.kyc_access_log_append_only() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.kyc_access_log_append_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS kyc_access_log_no_change ON public.kyc_access_log;
CREATE TRIGGER kyc_access_log_no_change
  BEFORE UPDATE OR DELETE ON public.kyc_access_log
  FOR EACH ROW EXECUTE FUNCTION public.kyc_access_log_append_only();

DROP TRIGGER IF EXISTS kyc_access_log_no_truncate ON public.kyc_access_log;
CREATE TRIGGER kyc_access_log_no_truncate
  BEFORE TRUNCATE ON public.kyc_access_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.kyc_access_log_append_only();
