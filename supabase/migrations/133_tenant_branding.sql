-- ============================================================
-- 133_tenant_branding.sql
--
-- Per-tenant branding and neutral defaults, so a second customer does not
-- see Vircle's name on their workspace, their ticket numbers or their
-- website chat widget.
--
--   accounts.brand_name / brand_logo_url
--       The product name and logo shown in the app chrome (sidebar, page
--       title). NULL = the neutral product default ("Halo" and the stock
--       mark). Written by workspace admins (settings.workspace) through
--       the existing accounts guard, no new capability.
--   web_widget_config.brand_name
--       The company name the website chat widget uses in its own sentences
--       ("I'm already a <brand> user"). NULL = the widget uses neutral
--       wording that names nobody.
--   accounts.ticket_key_prefix default 'VIR' -> 'TKT'
--       Existing accounts keep theirs; only new accounts change.
--   platform_list_accounts() gains `seed_ok`, and platform_reseed_account()
--       repairs a tenant whose default ticket types / resolutions are
--       missing. The seed triggers swallow their own errors so signup never
--       breaks (016/096/128), which made a failed seed invisible; the
--       operator console now shows it and can fix it.
--
-- Existing rows are backfilled with Vircle's wording so Vircle's own
-- workspace looks exactly as before. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Branding columns
-- ------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS brand_name     TEXT,
  ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_brand_name_check;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_brand_name_check
  CHECK (brand_name IS NULL OR length(btrim(brand_name)) BETWEEN 1 AND 60);

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_brand_logo_url_check;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_brand_logo_url_check
  CHECK (brand_logo_url IS NULL OR (brand_logo_url ~ '^https://' AND length(brand_logo_url) <= 500));

UPDATE public.accounts SET brand_name = 'Vircle Halo' WHERE brand_name IS NULL;

ALTER TABLE public.web_widget_config
  ADD COLUMN IF NOT EXISTS brand_name TEXT;

ALTER TABLE public.web_widget_config DROP CONSTRAINT IF EXISTS web_widget_config_brand_name_check;
ALTER TABLE public.web_widget_config ADD CONSTRAINT web_widget_config_brand_name_check
  CHECK (brand_name IS NULL OR length(btrim(brand_name)) BETWEEN 1 AND 60);

UPDATE public.web_widget_config SET brand_name = 'Vircle' WHERE brand_name IS NULL;

-- ------------------------------------------------------------
-- 2. Neutral ticket prefix for new accounts
-- ------------------------------------------------------------
ALTER TABLE public.accounts ALTER COLUMN ticket_key_prefix SET DEFAULT 'TKT';

-- ------------------------------------------------------------
-- 3. Seed health: show it, and let the operator repair it
-- ------------------------------------------------------------
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
               (ap.account_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM public.ticket_types       x WHERE x.account_id = a.id)
                  AND EXISTS (SELECT 1 FROM public.ticket_resolutions x WHERE x.account_id = a.id)) AS seed_ok,
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

-- Re-run every per-account default (all idempotent: they insert missing
-- rows only and never touch anything the tenant has edited).
CREATE OR REPLACE FUNCTION public.platform_reseed_account(p_account UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.platform_require_admin();
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = p_account) THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.account_platform (account_id, features)
  VALUES (p_account, '{"incidents": false}'::jsonb)
  ON CONFLICT (account_id) DO NOTHING;

  PERFORM public.ticket_types_seed(p_account);
  PERFORM public.ticket_resolutions_seed(p_account);

  BEGIN
    PERFORM public.log_audit(p_account, 'updated', 'account_platform', p_account, 'Defaults re-seeded', NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'platform_reseed_account audit failed: %', SQLERRM;
  END;
END;
$$;
ALTER FUNCTION public.platform_reseed_account(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_reseed_account(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_reseed_account(UUID) TO authenticated, service_role;
