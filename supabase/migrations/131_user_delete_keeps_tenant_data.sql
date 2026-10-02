-- ============================================================
-- 131_user_delete_keeps_tenant_data.sql
--
-- Deleting a person (an auth.users row) must never delete the company's
-- data. Since 017 the `user_id` / `connected_by_user_id` columns on shared
-- tenant tables are only attribution ("who created / connected this"),
-- but they were still NOT NULL ... ON DELETE CASCADE, so removing one
-- member's auth user — a leaver, a GDPR erasure — also deleted every
-- contact, conversation, flow, automation, template, pipeline, broadcast
-- and channel connection they had ever created, for the whole account.
--
-- Switch those columns to nullable ON DELETE SET NULL. Genuinely
-- per-person rows (notifications, presence, saved filters, watchers,
-- channel memberships, profiles themselves) keep cascading. The
-- application never relies on these columns being non-null at read time.
-- Idempotent.
-- ============================================================
DO $m$
DECLARE
  r     RECORD;
  v_con TEXT;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('automation_logs',               'user_id'),
      ('automation_pending_executions', 'user_id'),
      ('automations',                   'user_id'),
      ('broadcasts',                    'user_id'),
      ('contact_notes',                 'user_id'),
      ('contacts',                      'user_id'),
      ('conversations',                 'user_id'),
      ('custom_fields',                 'user_id'),
      ('deals',                         'user_id'),
      ('email_config',                  'connected_by_user_id'),
      ('flow_runs',                     'user_id'),
      ('flows',                         'user_id'),
      ('gmail_config',                  'connected_by_user_id'),
      ('instagram_config',              'connected_by_user_id'),
      ('message_templates',             'user_id'),
      ('messenger_config',              'connected_by_user_id'),
      ('pipelines',                     'user_id'),
      ('tags',                          'user_id'),
      ('tiktok_config',                 'connected_by_user_id'),
      ('web_widget_config',             'user_id'),
      ('whatsapp_config',               'user_id')
    ) AS t(tbl, col)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN CONTINUE; END IF;

    FOR v_con IN
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f'
         AND c.conrelid = ('public.' || r.tbl)::regclass
         AND c.confrelid = 'auth.users'::regclass
         AND a.attname = r.col
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tbl, v_con);
    END LOOP;

    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', r.tbl, r.col);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES auth.users(id) ON DELETE SET NULL',
      r.tbl, r.tbl || '_' || r.col || '_fkey', r.col
    );
  END LOOP;
END
$m$;
