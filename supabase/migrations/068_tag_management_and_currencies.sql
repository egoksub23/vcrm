-- ============================================================
-- 068_tag_management_and_currencies
--
-- Two settings features:
--
-- 1. Tag / conversation-label management. Contact tags and conversation
--    labels have always shared the `tags` table (migration 044), so the
--    Settings pages for "Tags" and "Conversation labels" would have
--    listed identical rows. Two usage flags let one palette be presented
--    as two lists:
--      for_contacts       — offered when tagging a contact
--      for_conversations  — offered when labelling a conversation
--    Existing rows keep BOTH flags (nothing changes for them) unless
--    their history shows they were only ever used one way. `description`
--    is new (respond.io's category list carries one, and the AI
--    auto-label pass reads descriptions); `updated_at` backs the "last
--    edited" column. Names become unique per account (case-insensitive)
--    so a CSV import can upsert by name instead of piling up duplicates.
--
--    `tag_usage_counts` is a security_invoker view, so RLS on `tags`,
--    `contact_tags` and `conversation_labels` still applies — the
--    Settings tables show "in use" counts in one query.
--
-- 2. Per-account currency list. `accounts.currencies` is a JSON array of
--    { code, label } objects. NULL means "not customised yet" and the
--    app falls back to its built-in list, so existing accounts pick up
--    new built-ins (e.g. MYR) without a data migration. The existing
--    `accounts_update` policy (admin+) already governs writes.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ---------- tags ----------
ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS for_contacts BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS for_conversations BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Narrow existing rows only where their history is unambiguous. Rows
-- that are unused, or used both ways, stay in both lists.
UPDATE tags t
   SET for_contacts = FALSE
 WHERE (
         EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.tag_id = t.id)
      OR EXISTS (SELECT 1 FROM auto_label_rules r WHERE r.tag_id = t.id)
       )
   AND NOT EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.tag_id = t.id);

UPDATE tags t
   SET for_conversations = FALSE
 WHERE EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.tag_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.tag_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM auto_label_rules r WHERE r.tag_id = t.id);

ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_used_somewhere;
ALTER TABLE tags
  ADD CONSTRAINT tags_used_somewhere CHECK (for_contacts OR for_conversations);

-- Rename pre-existing case-insensitive duplicates so the unique index
-- below can be created (later rows get " (2)", " (3)", ...).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY account_id, LOWER(name) ORDER BY created_at, id
         ) AS rn
    FROM tags
)
UPDATE tags t
   SET name = t.name || ' (' || r.rn || ')'
  FROM ranked r
 WHERE r.id = t.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_account_name_ci
  ON tags (account_id, LOWER(name));

DROP TRIGGER IF EXISTS set_updated_at ON tags;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON tags
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- usage counts (RLS-respecting) ----------
CREATE OR REPLACE VIEW tag_usage_counts
  WITH (security_invoker = true) AS
SELECT
  t.id AS tag_id,
  (SELECT COUNT(*) FROM contact_tags ct WHERE ct.tag_id = t.id)::INT AS contact_count,
  (SELECT COUNT(*) FROM conversation_labels cl WHERE cl.tag_id = t.id)::INT AS conversation_count
FROM tags t;

GRANT SELECT ON tag_usage_counts TO authenticated;

-- ---------- currencies ----------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS currencies JSONB;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_currencies_is_array;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_currencies_is_array
  CHECK (currencies IS NULL OR jsonb_typeof(currencies) = 'array');
