-- ============================================================
-- Verification for migration 097 (per-channel `enabled` pause switch).
--
-- Run against a database that already has 097 applied:
--   supabase db query --linked -f supabase/ci/verify-097-channel-enabled-toggle.sql
--
-- Or BEFORE applying, with the draft in front (the whole thing rolls back):
--   cat supabase/ci/drafts/097_channel_enabled_toggle.sql \
--       supabase/ci/verify-097-channel-enabled-toggle.sql > /tmp/both.sql
--   supabase db query --linked -f /tmp/both.sql
--
-- One DO block that ends with RAISE EXCEPTION 'ROLLBACK-OK: ...', so nothing
-- is ever committed. A message starting with ROLLBACK-OK means every check
-- passed; any other error message names the check that failed. Purely a
-- column-shape check — no RLS/business logic to simulate for an additive
-- boolean column with a default.
-- ============================================================

DO $verify$
DECLARE
  tbl TEXT;
  col_default TEXT;
  col_nullable TEXT;
  existing_row_enabled BOOLEAN;
  any_existing_row BOOLEAN;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'whatsapp_config', 'messenger_config', 'instagram_config',
    'email_config', 'gmail_config', 'tiktok_config'
  ]
  LOOP
    SELECT column_default, is_nullable
      INTO col_default, col_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'enabled';

    IF col_default IS NULL THEN
      RAISE EXCEPTION '% has no enabled column', tbl;
    END IF;
    IF col_default NOT ILIKE '%true%' THEN
      RAISE EXCEPTION '%.enabled default is not true: %', tbl, col_default;
    END IF;
    IF col_nullable <> 'NO' THEN
      RAISE EXCEPTION '%.enabled is nullable, expected NOT NULL', tbl;
    END IF;

    -- Any existing row (from before this migration ran) must have
    -- backfilled to true, not NULL — proves the ADD COLUMN ... DEFAULT
    -- actually populated old rows rather than leaving them unset.
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', tbl) INTO any_existing_row;
    IF any_existing_row THEN
      EXECUTE format('SELECT bool_and(enabled IS NOT NULL) FROM %I', tbl) INTO existing_row_enabled;
      IF NOT existing_row_enabled THEN
        RAISE EXCEPTION '% has a row with enabled IS NULL', tbl;
      END IF;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'ROLLBACK-OK: 097 verified — enabled column present, NOT NULL, default true on all six channel config tables, no NULLs on existing rows';
END $verify$;
