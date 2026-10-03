-- ============================================================
-- 155: first-run onboarding for a new customer admin.
--
-- A short checklist on the dashboard (connect a channel, invite the team, add
-- contacts, plus three optional extras), driven by what the workspace is still
-- missing, so it is always accurate and never has to be ticked by hand.
--
--   onboarding_status(account)   what exists, as true/false only, for any member
--                                (a SECURITY DEFINER read, so a role that cannot
--                                read a channel's settings still gets a correct
--                                answer); never any content
--   onboarding_dismiss(account)  hide the checklist for the whole workspace
--                                (settings.workspace)
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.account_onboarding (
  account_id   UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  dismissed_at TIMESTAMPTZ,
  dismissed_by UUID
);
ALTER TABLE public.account_onboarding ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_onboarding_select ON public.account_onboarding;
CREATE POLICY account_onboarding_select ON public.account_onboarding
  FOR SELECT USING (public.is_account_member(account_id));
-- No write policies: onboarding_dismiss() writes.

CREATE OR REPLACE FUNCTION public.onboarding_status(p_account UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_channel BOOLEAN := false;
  t         TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_account_member(p_account) THEN
    RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
  END IF;

  -- A channel counts once it is connected: WhatsApp when its status says so, the web widget
  -- once it is switched on, every other channel as soon as its connection exists.
  v_channel := EXISTS (SELECT 1 FROM public.whatsapp_config c WHERE c.account_id = p_account AND c.status = 'connected')
            OR EXISTS (SELECT 1 FROM public.web_widget_config c WHERE c.account_id = p_account AND c.enabled);
  IF NOT v_channel THEN
    FOREACH t IN ARRAY ARRAY['messenger_config', 'instagram_config', 'email_config', 'gmail_config', 'tiktok_config', 'vircle_chat_config'] LOOP
      IF to_regclass('public.' || t) IS NOT NULL THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I c WHERE c.account_id = $1)', t) INTO v_channel USING p_account;
        EXIT WHEN v_channel;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'has_channel',   v_channel,
    'has_team',      (SELECT count(*) FROM public.profiles p WHERE p.account_id = p_account) > 1
                     OR EXISTS (SELECT 1 FROM public.account_invitations i WHERE i.account_id = p_account),
    'has_contacts',  EXISTS (SELECT 1 FROM public.contacts c WHERE c.account_id = p_account AND c.deleted_at IS NULL),
    'has_replies',   EXISTS (SELECT 1 FROM public.quick_replies q WHERE q.account_id = p_account AND q.deleted_at IS NULL),
    'has_hours',     EXISTS (SELECT 1 FROM public.business_hours_schedules s WHERE s.account_id = p_account),
    'has_knowledge', EXISTS (SELECT 1 FROM public.ai_knowledge_documents d WHERE d.account_id = p_account AND d.deleted_at IS NULL),
    'dismissed',     EXISTS (SELECT 1 FROM public.account_onboarding o WHERE o.account_id = p_account AND o.dismissed_at IS NOT NULL)
  );
END;
$$;
ALTER FUNCTION public.onboarding_status(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.onboarding_status(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.onboarding_status(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.onboarding_dismiss(p_account UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_capability(p_account, 'settings.workspace') THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.account_onboarding (account_id, dismissed_at, dismissed_by)
  VALUES (p_account, now(), auth.uid())
  ON CONFLICT (account_id) DO UPDATE SET dismissed_at = now(), dismissed_by = auth.uid();
END;
$$;
ALTER FUNCTION public.onboarding_dismiss(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.onboarding_dismiss(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.onboarding_dismiss(UUID) TO authenticated, service_role;
