-- ============================================================
-- 170_sign_misc_p2.sql
--
-- Doc Sign, work package 20b: template test mode (F-10) and attaching a document to a ticket or deal (F-51).
-- (Replacing the file of a draft, F-77, and add-on updates, F-81, need no schema change: a draft's file columns are
-- free until it is sent, and an add-on's installed version is already recorded in sign_addons.)
--
--   sign_documents.test           a document sent from a template to try it out: marked TEST on every page of the signed
--                                 file, in the emails and on the signing page, never counted against the monthly limit,
--                                 never sent to webhooks or automations (the app decides those two), kept for 30 days
--                                 after it completes (a trigger below) and then deletable like any other.
--   account_usage()               recreated from 157: `sign_documents_month` no longer counts a test document.
--   sign_documents_test_guard     `test` is fixed when the document is sent: a draft may become a test or stop being one,
--                                 a document that was sent can never change, so "send for real, then call it a test"
--                                 cannot hide a document from the limit, and a test cannot turn into a real record.
--   sign_documents_test_retention a test document's retention date is at most 30 days after it completes (the category's
--                                 or the workspace's longer date would otherwise apply).
--   sign_documents_links_guard    the ticket and the deal a document is attached to must belong to the same workspace
--                                 (157 only had a foreign key on the id, which crosses workspaces). The app checks the
--                                 contact too, with words; the database holds the workspace line.
--
-- Everything here is for the server (service role). Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The test flag
-- ------------------------------------------------------------
ALTER TABLE public.sign_documents ADD COLUMN IF NOT EXISTS test BOOLEAN NOT NULL DEFAULT FALSE;

-- "Show me my test documents" and "do not count the tests": a small partial index, test documents are few.
CREATE INDEX IF NOT EXISTS sign_documents_test_idx ON public.sign_documents (account_id, created_at DESC) WHERE test;

CREATE OR REPLACE FUNCTION public.sign_documents_test_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.test IS DISTINCT FROM OLD.test THEN
    RAISE EXCEPTION 'sign_document_test_is_fixed' USING ERRCODE = '23514',
      DETAIL = 'Whether a document is a test is decided before it is sent and never changes.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sign_documents_test_guard ON public.sign_documents;
CREATE TRIGGER sign_documents_test_guard
  BEFORE UPDATE ON public.sign_documents
  FOR EACH ROW
  WHEN (OLD.test IS DISTINCT FROM NEW.test)
  EXECUTE FUNCTION public.sign_documents_test_guard();

-- A test document that completes is kept for 30 days at most. The retention lock of 165 only refuses to SHORTEN a date that
-- exists; at completion there is none yet (sign_finish_sealing fills it), so this runs in the same update that sets it.
CREATE OR REPLACE FUNCTION public.sign_documents_test_retention()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.retain_until := LEAST(COALESCE(NEW.retain_until, now() + interval '30 days'), now() + interval '30 days');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sign_documents_test_retention ON public.sign_documents;
CREATE TRIGGER sign_documents_test_retention
  BEFORE UPDATE ON public.sign_documents
  FOR EACH ROW
  WHEN (NEW.test AND NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.sign_documents_test_retention();

-- ------------------------------------------------------------
-- 2. Usage: documents sent this month, without the tests (157's function, one condition added)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_usage(p_account UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_month_start TIMESTAMPTZ := date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc';
  v_storage     BIGINT;
  v_measured    TIMESTAMPTZ;
BEGIN
  -- The service role (the app's own checks) has no auth.uid(); a person must be an
  -- admin of this workspace (the capability that also reads the daily table) or an operator.
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_capability(p_account, 'settings.workspace') OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT d.storage_bytes, d.measured_at INTO v_storage, v_measured
    FROM public.account_usage_daily d
   WHERE d.account_id = p_account
   ORDER BY d.day DESC LIMIT 1;

  RETURN jsonb_build_object(
    'contacts',        (SELECT count(*) FROM public.contacts c WHERE c.account_id = p_account AND c.deleted_at IS NULL),
    'members',         (SELECT count(*) FROM public.profiles p WHERE p.account_id = p_account),
    'conversations',   (SELECT count(*) FROM public.conversations v WHERE v.account_id = p_account),
    'messages_month',  (SELECT count(*) FROM public.messages m
                         WHERE m.account_id = p_account AND m.created_at >= v_month_start
                           AND m.sender_type IN ('agent', 'bot') AND NOT m.is_internal AND m.status <> 'failed'),
    'ai_tokens_month', COALESCE((SELECT sum(l.total_tokens) FROM public.ai_usage_log l
                                  WHERE l.account_id = p_account AND l.created_at >= v_month_start), 0),
    -- a test document (170) is a rehearsal: it never counts against `sign_documents_per_month`
    'sign_documents_month', (SELECT count(*) FROM public.sign_documents s
                              WHERE s.account_id = p_account AND s.sent_at >= v_month_start AND NOT s.test),
    'storage_bytes',   COALESCE(v_storage, 0),
    'storage_measured_at', v_measured,
    'limits',          COALESCE((SELECT ap.limits FROM public.account_platform ap WHERE ap.account_id = p_account), '{}'::jsonb)
  );
END;
$$;
ALTER FUNCTION public.account_usage(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_usage(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_usage(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. A ticket or a deal a document is attached to belongs to the document's workspace
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_documents_links_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.ticket_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tickets t WHERE t.id = NEW.ticket_id AND t.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'sign_document_ticket_not_in_workspace' USING ERRCODE = '23514';
  END IF;
  IF NEW.deal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.deals d WHERE d.id = NEW.deal_id AND d.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'sign_document_deal_not_in_workspace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_documents_links_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_documents_links_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sign_documents_links_guard ON public.sign_documents;
CREATE TRIGGER sign_documents_links_guard
  BEFORE INSERT OR UPDATE OF ticket_id, deal_id ON public.sign_documents
  FOR EACH ROW
  WHEN (NEW.ticket_id IS NOT NULL OR NEW.deal_id IS NOT NULL)
  EXECUTE FUNCTION public.sign_documents_links_guard();

-- Finding "the documents of this ticket / this deal" (the Documents panel on both).
CREATE INDEX IF NOT EXISTS sign_documents_ticket_idx ON public.sign_documents (ticket_id, created_at DESC) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sign_documents_deal_idx   ON public.sign_documents (deal_id, created_at DESC)   WHERE deal_id IS NOT NULL;
