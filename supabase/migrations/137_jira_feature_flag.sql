-- ============================================================
-- 137: Jira link becomes an operator-controlled module.
--
-- Product scope: the communication stack and tickets are what is offered to
-- customer workspaces. The Jira link and Incident Reporting are Vircle's own
-- tooling, so both start OFF for a new workspace (the operator can switch
-- either on per workspace in the Platform console). Existing workspaces keep
-- Jira exactly as it is today: the flag is written explicitly as true for
-- them rather than relying on "absent = enabled".
--
-- No capability or route changes are needed here: the app removes every
-- jira.* capability from a workspace whose flag is off, and every
-- /api/integrations/jira route, the Integrations settings section and the
-- Jira panel of a ticket already sit behind those capabilities.
-- ============================================================

UPDATE public.account_platform
SET features = features || '{"jira": true}'::jsonb
WHERE NOT (features ? 'jira');

CREATE OR REPLACE FUNCTION public.account_platform_seed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.account_platform (account_id, features)
  VALUES (NEW.id, '{"incidents": false, "jira": false}'::jsonb)
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
