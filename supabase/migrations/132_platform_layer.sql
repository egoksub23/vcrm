-- ============================================================
-- 132_platform_layer.sql
--
-- The operator layer a multi-tenant deployment needs and 017 never had:
-- who may administer tenants, and per-tenant status / plan / limits /
-- feature flags that a tenant's own admins can READ but never WRITE.
--
--   platform_admins   operator logins (separate from account roles; a
--                     platform admin is still an ordinary member of
--                     exactly one account, so no membership rewrite).
--   account_platform  one row per account: status ('active'|'suspended'),
--                     plan, limits jsonb, features jsonb, suspension
--                     bookkeeping. Deliberately NOT columns on `accounts`:
--                     that table's update policy is a capability
--                     blacklist (088/096/123), so any new column there
--                     would be tenant-writable by default. Members can
--                     SELECT their own row; nothing is writable except
--                     through the operator RPCs below.
--   platform_* RPCs   SECURITY DEFINER, gated by is_platform_admin():
--                     list tenants, set status (suspend pauses every
--                     channel through the existing `enabled` switches
--                     from 097 and remembers what was on, resume puts
--                     back exactly that), update plan/limits/features.
--
-- Also closes audit finding S7: tenant admins could write
-- accounts.owner_user_id / ticket_seq / incident_seq directly.
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Operators
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
-- No policies: only the DEFINER functions below (and service_role) touch it.

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid());
$$;
ALTER FUNCTION public.is_platform_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Per-account platform settings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_platform (
  account_id         UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  plan               TEXT NOT NULL DEFAULT 'standard',
  -- {"seats": 10}  absent key = unlimited
  limits             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- {"incidents": false}  absent key = enabled (so a new flag never
  -- silently switches an existing feature off for existing tenants)
  features           JSONB NOT NULL DEFAULT '{}'::jsonb,
  suspended_at       TIMESTAMPTZ,
  suspended_reason   TEXT,
  -- channel rows that were `enabled` when the account was suspended:
  -- {"whatsapp_config": ["<id>", ...], ...}
  paused_channels    JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT account_platform_limits_object   CHECK (jsonb_typeof(limits)   = 'object'),
  CONSTRAINT account_platform_features_object CHECK (jsonb_typeof(features) = 'object')
);
ALTER TABLE public.account_platform ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_platform_select ON public.account_platform;
CREATE POLICY account_platform_select ON public.account_platform
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id));
-- No INSERT/UPDATE/DELETE policy on purpose: writes go through the RPCs.

-- Existing tenants keep every feature exactly as it is today (Vircle uses
-- Incident Reporting). New tenants start with the Vircle-specific
-- Incident Reporting module off.
INSERT INTO public.account_platform (account_id, features)
SELECT id, '{"incidents": true}'::jsonb FROM public.accounts
ON CONFLICT (account_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.account_platform_seed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.account_platform (account_id, features)
  VALUES (NEW.id, '{"incidents": false}'::jsonb)
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block signup; readers treat a missing row as active/all-features.
  RAISE WARNING 'account_platform_seed failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.account_platform_seed() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_platform_seed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_account_seed_platform ON public.accounts;
CREATE TRIGGER on_account_seed_platform
  AFTER INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.account_platform_seed();

DROP TRIGGER IF EXISTS set_updated_at ON public.account_platform;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.account_platform
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ------------------------------------------------------------
-- 3. Operator RPCs
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_require_admin()
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform administrator access required' USING ERRCODE = '42501';
  END IF;
END;
$$;
ALTER FUNCTION public.platform_require_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_require_admin() FROM PUBLIC, anon, authenticated;

-- All tenants with the numbers an operator needs at a glance.
CREATE OR REPLACE FUNCTION public.platform_list_accounts()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.platform_require_admin();
  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.created_at DESC)
      FROM (
        SELECT a.id,
               a.name,
               a.created_at,
               u.email                              AS owner_email,
               COALESCE(ap.status, 'active')        AS status,
               COALESCE(ap.plan, 'standard')        AS plan,
               COALESCE(ap.limits, '{}'::jsonb)     AS limits,
               COALESCE(ap.features, '{}'::jsonb)   AS features,
               ap.suspended_at,
               ap.suspended_reason,
               (SELECT count(*) FROM public.profiles p WHERE p.account_id = a.id)       AS members,
               (SELECT count(*) FROM public.contacts c WHERE c.account_id = a.id)       AS contacts,
               (SELECT count(*) FROM public.conversations v WHERE v.account_id = a.id)  AS conversations
          FROM public.accounts a
          LEFT JOIN auth.users u ON u.id = a.owner_user_id
          LEFT JOIN public.account_platform ap ON ap.account_id = a.id
      ) t
  ), '[]'::jsonb);
END;
$$;
ALTER FUNCTION public.platform_list_accounts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_list_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_list_accounts() TO authenticated, service_role;

-- Plan / limits / feature flags. Features and limits MERGE into what is
-- there (a key set to JSON null is removed), so one flag can be flipped
-- without resending the rest.
CREATE OR REPLACE FUNCTION public.platform_update_account(
  p_account  UUID,
  p_plan     TEXT  DEFAULT NULL,
  p_limits   JSONB DEFAULT NULL,
  p_features JSONB DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.account_platform;
BEGIN
  PERFORM public.platform_require_admin();
  IF p_limits IS NOT NULL AND jsonb_typeof(p_limits) <> 'object' THEN
    RAISE EXCEPTION 'limits must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_features IS NOT NULL AND jsonb_typeof(p_features) <> 'object' THEN
    RAISE EXCEPTION 'features must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_plan IS NOT NULL AND (length(btrim(p_plan)) = 0 OR length(p_plan) > 40) THEN
    RAISE EXCEPTION 'plan must be 1-40 characters' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account) THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.account_platform (account_id) VALUES (p_account)
  ON CONFLICT (account_id) DO NOTHING;

  UPDATE public.account_platform ap
     SET plan     = COALESCE(btrim(p_plan), ap.plan),
         limits   = CASE WHEN p_limits   IS NULL THEN ap.limits
                         ELSE jsonb_strip_nulls(ap.limits   || p_limits)   END,
         features = CASE WHEN p_features IS NULL THEN ap.features
                         ELSE jsonb_strip_nulls(ap.features || p_features) END
   WHERE ap.account_id = p_account
   RETURNING * INTO v_row;

  BEGIN
    PERFORM public.log_audit(
      p_account, 'updated', 'account_platform', p_account, 'Platform settings',
      jsonb_build_object('plan', v_row.plan, 'limits', v_row.limits, 'features', v_row.features));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'platform_update_account audit failed: %', SQLERRM;
  END;
END;
$$;
ALTER FUNCTION public.platform_update_account(UUID, TEXT, JSONB, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_update_account(UUID, TEXT, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_update_account(UUID, TEXT, JSONB, JSONB) TO authenticated, service_role;

-- Suspend / resume. Suspending switches every channel off through the
-- existing per-channel `enabled` flag (097; every inbound/outbound path
-- already honours it) and remembers exactly which rows were on; resuming
-- turns back on only those, so a channel the tenant had paused themselves
-- stays paused.
CREATE OR REPLACE FUNCTION public.platform_set_account_status(
  p_account UUID,
  p_status  TEXT,
  p_reason  TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tbl      TEXT;
  v_ids      UUID[];
  v_snapshot JSONB := '{}'::jsonb;
  v_prev     JSONB;
  v_current  TEXT;
BEGIN
  PERFORM public.platform_require_admin();
  IF p_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'status must be active or suspended' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account) THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = '22023';
  END IF;

  -- An operator must not lock themselves out of the console.
  IF p_status = 'suspended' AND EXISTS (
    SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND account_id = p_account
  ) THEN
    RAISE EXCEPTION 'You cannot suspend your own workspace' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.account_platform (account_id) VALUES (p_account)
  ON CONFLICT (account_id) DO NOTHING;

  SELECT status, paused_channels INTO v_current, v_prev
    FROM public.account_platform WHERE account_id = p_account FOR UPDATE;

  IF v_current = p_status THEN
    RETURN;  -- already there; do not overwrite the snapshot
  END IF;

  IF p_status = 'suspended' THEN
    FOREACH v_tbl IN ARRAY ARRAY['whatsapp_config', 'messenger_config', 'instagram_config',
                                 'email_config', 'gmail_config', 'tiktok_config', 'web_widget_config']
    LOOP
      EXECUTE format('SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) FROM public.%I WHERE account_id = $1 AND enabled', v_tbl)
        INTO v_ids USING p_account;
      v_snapshot := v_snapshot || jsonb_build_object(v_tbl, to_jsonb(v_ids));
      EXECUTE format('UPDATE public.%I SET enabled = false WHERE account_id = $1 AND enabled', v_tbl)
        USING p_account;
    END LOOP;

    UPDATE public.account_platform
       SET status = 'suspended', suspended_at = NOW(), suspended_reason = NULLIF(btrim(p_reason), ''),
           paused_channels = v_snapshot
     WHERE account_id = p_account;
  ELSE
    IF v_prev IS NOT NULL THEN
      FOR v_tbl IN SELECT jsonb_object_keys(v_prev) LOOP
        SELECT COALESCE(array_agg(x::uuid), ARRAY[]::uuid[])
          INTO v_ids FROM jsonb_array_elements_text(v_prev -> v_tbl) AS x;
        EXECUTE format('UPDATE public.%I SET enabled = true WHERE account_id = $1 AND id = ANY ($2)', v_tbl)
          USING p_account, v_ids;
      END LOOP;
    END IF;

    UPDATE public.account_platform
       SET status = 'active', suspended_at = NULL, suspended_reason = NULL, paused_channels = NULL
     WHERE account_id = p_account;
  END IF;

  BEGIN
    PERFORM public.log_audit(
      p_account, 'updated', 'account_platform', p_account, 'Account ' || p_status,
      jsonb_build_object('status', p_status, 'reason', NULLIF(btrim(p_reason), '')));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'platform_set_account_status audit failed: %', SQLERRM;
  END;
END;
$$;
ALTER FUNCTION public.platform_set_account_status(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_set_account_status(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_account_status(UUID, TEXT, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. S7: a tenant admin may not write the operator-owned columns of
--    `accounts`. (123's guard, reproduced with one new block; every
--    legitimate writer — transfer_account_ownership, next_ticket_number,
--    next_incident_number — is SECURITY DEFINER and not `authenticated`.)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accounts_capability_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_prefix           BOOLEAN;
  v_auto             BOOLEAN;
  v_incident_contact BOOLEAN;
  v_other            BOOLEAN;
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.ticket_seq   IS DISTINCT FROM OLD.ticket_seq
     OR NEW.incident_seq IS DISTINCT FROM OLD.incident_seq
  THEN
    RAISE EXCEPTION 'owner_user_id and the number counters cannot be changed directly'
      USING ERRCODE = '42501';
  END IF;

  v_prefix := NEW.ticket_key_prefix IS DISTINCT FROM OLD.ticket_key_prefix;
  v_auto   := NEW.auto_label_ai_enabled IS DISTINCT FROM OLD.auto_label_ai_enabled;
  v_incident_contact := (NEW.incident_contact_name, NEW.incident_contact_role, NEW.incident_contact_mobile, NEW.incident_contact_email)
                         IS DISTINCT FROM
                         (OLD.incident_contact_name, OLD.incident_contact_role, OLD.incident_contact_mobile, OLD.incident_contact_email);
  v_other  := (to_jsonb(NEW) - 'ticket_key_prefix' - 'auto_label_ai_enabled' - 'updated_at'
                - 'incident_contact_name' - 'incident_contact_role' - 'incident_contact_mobile' - 'incident_contact_email')
              IS DISTINCT FROM
              (to_jsonb(OLD) - 'ticket_key_prefix' - 'auto_label_ai_enabled' - 'updated_at'
                - 'incident_contact_name' - 'incident_contact_role' - 'incident_contact_mobile' - 'incident_contact_email');

  IF v_other AND NOT has_capability(OLD.id, 'settings.workspace') THEN
    RAISE EXCEPTION 'This action requires the ''settings.workspace'' permission'
      USING ERRCODE = '42501';
  END IF;
  IF v_prefix AND NOT has_capability(OLD.id, 'tickets.configure-form') THEN
    RAISE EXCEPTION 'This action requires the ''tickets.configure-form'' permission'
      USING ERRCODE = '42501';
  END IF;
  IF v_auto AND NOT has_capability(OLD.id, 'tags.manage') THEN
    RAISE EXCEPTION 'This action requires the ''tags.manage'' permission'
      USING ERRCODE = '42501';
  END IF;
  IF v_incident_contact AND NOT has_capability(OLD.id, 'incidents.manage') THEN
    RAISE EXCEPTION 'This action requires the ''incidents.manage'' permission'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.accounts_capability_guard() FROM PUBLIC, anon, authenticated;
