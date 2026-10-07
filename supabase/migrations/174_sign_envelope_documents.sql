-- ============================================================
-- 174_sign_envelope_documents.sql
--
-- Doc Sign, document collections (the envelopes of migration 171): a collection that is still a draft can have documents added,
-- removed and put in a different order. Adding and removing need no change here (a draft joins a draft envelope, and a draft is
-- deleted, as before). What 171 did not allow is a different ORDER: a document's place in its envelope was fixed once set, and the
-- places are unique, so no document could take another's place.
--
--   sign_documents_envelope_position_uq   the unique place per envelope, as a DEFERRABLE constraint (INITIALLY IMMEDIATE, so every
--                                         other statement is checked at once as before) in place of the unique index of 171, so a
--                                         whole new order can be written in one step
--   sign_documents_envelope_guard         recreated (from 171): the place of a draft document in a draft envelope may change, and only
--                                         while sign_envelope_set_order is the one acting (a transaction-local marker naming the
--                                         envelope); the envelope of a document, and every other rule, stay fixed
--   sign_envelope_set_order               the new order of ALL the documents of a draft envelope, as the list of their ids: places 1 to
--                                         n in that order, in one transaction, under the envelope's lock; refused when the envelope is
--                                         not a draft, when a document is not a draft, or when the list is not exactly the documents
--
-- The people of a collection are tied together by the row on each person's FIRST document (the anchor); the service writes the
-- people again after a change of order or a removal (the same function a person is saved with), so the anchors follow the places.
-- For the service role only, with the grants of 171. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The place is unique per envelope, checked at the end of the statement as before, or later when the order is rewritten
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sign_documents_envelope_position_uq' AND conrelid = 'public.sign_documents'::regclass) THEN
    ALTER TABLE public.sign_documents
      ADD CONSTRAINT sign_documents_envelope_position_uq UNIQUE (envelope_id, envelope_position) DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
-- a null envelope never collides with anything, so this holds exactly what the partial index held
DROP INDEX IF EXISTS public.sign_documents_envelope_position_idx;

-- ------------------------------------------------------------
-- 2. The guard: a place is fixed, except for the order being rewritten by sign_envelope_set_order
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_documents_envelope_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.sign_envelopes%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.envelope_id IS NOT NULL THEN
      IF NEW.envelope_id IS DISTINCT FROM OLD.envelope_id THEN
        RAISE EXCEPTION 'sign_document_envelope_is_fixed' USING ERRCODE = '23514';
      END IF;
      IF NEW.envelope_position IS DISTINCT FROM OLD.envelope_position
         AND NOT (OLD.status = 'draft' AND NEW.status = 'draft'
                  AND COALESCE(current_setting('app.sign_envelope_order', true), '') = OLD.envelope_id::text) THEN
        RAISE EXCEPTION 'sign_document_envelope_is_fixed' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.envelope_id IS NOT NULL AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'sign_document_envelope_is_fixed' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.envelope_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR OLD.envelope_id IS NULL THEN
    SELECT * INTO e FROM public.sign_envelopes WHERE id = NEW.envelope_id AND account_id = NEW.account_id;
    IF NOT FOUND OR e.status <> 'draft' THEN
      RAISE EXCEPTION 'sign_envelope_not_open_for_documents' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.allow_forwarding THEN
    RAISE EXCEPTION 'sign_envelope_no_forwarding' USING ERRCODE = '23514';
  END IF;
  IF NEW.test THEN
    RAISE EXCEPTION 'sign_envelope_no_test' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sign_documents_envelope_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_documents_envelope_guard() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. The new order of a draft collection, in one step
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sign_envelope_set_order(p_envelope UUID, p_ids UUID[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e       public.sign_envelopes%ROWTYPE;
  v_n     INTEGER;
  v_moved INTEGER;
BEGIN
  e := public.sign_envelope_lock(p_envelope);
  IF e.status <> 'draft' THEN
    RAISE EXCEPTION 'envelope_not_draft' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sign_documents d WHERE d.envelope_id = p_envelope AND d.status <> 'draft') THEN
    RAISE EXCEPTION 'envelope_not_draft' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO v_n FROM public.sign_documents WHERE envelope_id = p_envelope AND account_id = e.account_id;
  -- exactly the documents of the envelope, each once
  IF p_ids IS NULL OR cardinality(p_ids) <> v_n
     OR (SELECT count(DISTINCT x) FROM unnest(p_ids) x) <> v_n
     OR (SELECT count(*) FROM public.sign_documents d WHERE d.envelope_id = p_envelope AND d.account_id = e.account_id AND d.id = ANY (p_ids)) <> v_n THEN
    RAISE EXCEPTION 'envelope_order_mismatch' USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('app.sign_envelope_order', p_envelope::text, true);
  SET CONSTRAINTS public.sign_documents_envelope_position_uq DEFERRED;
  UPDATE public.sign_documents d
     SET envelope_position = o.ord::integer
    FROM unnest(p_ids) WITH ORDINALITY AS o(id, ord)
   WHERE d.id = o.id AND d.envelope_id = p_envelope AND d.envelope_position IS DISTINCT FROM o.ord::integer;
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  SET CONSTRAINTS public.sign_documents_envelope_position_uq IMMEDIATE;
  PERFORM set_config('app.sign_envelope_order', '', true);
  RETURN jsonb_build_object('count', v_n, 'moved', v_moved);
END;
$$;
ALTER FUNCTION public.sign_envelope_set_order(UUID, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sign_envelope_set_order(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_envelope_set_order(UUID, UUID[]) TO service_role;
