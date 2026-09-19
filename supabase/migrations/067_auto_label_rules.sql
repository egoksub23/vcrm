-- ============================================================
-- 067_auto_label_rules
--
-- "Auto-label by category" (roadmap P1): label an inbound conversation by
-- topic without an agent doing it. Until now it was only possible by
-- hand-building a keyword_match automation → add_conversation_label per
-- topic. This makes it first-class:
--
--   - auto_label_rules: label + keywords (+ match type) and/or a plain
--     description of the topic. Keywords are matched on every inbound
--     message; the description is what an optional AI pass reads.
--   - accounts.auto_label_ai_enabled: opt-in (default off) for the AI
--     pass, which only runs when NO keyword rule matched and the
--     conversation has no label yet — so spend is bounded to roughly one
--     classification per unlabeled conversation, on the account's own
--     BYO AI key.
--
-- Rules apply the SAME conversation labels agents apply by hand
-- (conversation_labels), so filters, the label_added automation trigger,
-- and reports all see them.
-- ============================================================

CREATE TABLE IF NOT EXISTS auto_label_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  match_type TEXT NOT NULL DEFAULT 'word' CHECK (match_type IN ('word', 'contains')),
  -- Plain-language description of the topic — the AI pass's hint.
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A rule with neither keywords nor a description could never fire.
  CONSTRAINT auto_label_rules_has_signal
    CHECK (cardinality(keywords) > 0 OR length(trim(coalesce(description, ''))) > 0)
);

CREATE INDEX IF NOT EXISTS idx_auto_label_rules_account
  ON auto_label_rules(account_id) WHERE is_active;

DROP TRIGGER IF EXISTS set_updated_at ON auto_label_rules;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON auto_label_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE auto_label_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auto_label_rules_select ON auto_label_rules;
DROP POLICY IF EXISTS auto_label_rules_insert ON auto_label_rules;
DROP POLICY IF EXISTS auto_label_rules_update ON auto_label_rules;
DROP POLICY IF EXISTS auto_label_rules_delete ON auto_label_rules;
CREATE POLICY auto_label_rules_select ON auto_label_rules
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY auto_label_rules_insert ON auto_label_rules
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY auto_label_rules_update ON auto_label_rules
  FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY auto_label_rules_delete ON auto_label_rules
  FOR DELETE USING (is_account_member(account_id, 'admin'));

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS auto_label_ai_enabled BOOLEAN NOT NULL DEFAULT false;

-- The AI pass logs its token spend like the other AI surfaces do. Widen
-- ai_usage_log.mode; drop the old CHECK by lookup, not by guessed name.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'ai_usage_log'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%mode%'
  LOOP
    EXECUTE format('ALTER TABLE ai_usage_log DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'auto_label'));
