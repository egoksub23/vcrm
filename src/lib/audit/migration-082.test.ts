import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Static guards on migration 082: the properties that are easy to break
// by editing the SQL and that the rolled-back verification script
// (supabase/ci/verify-082-audit.sql) proves against the real database.

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "082_audit_trail.sql"),
  "utf8",
);

describe("migration 082 (audit trail)", () => {
  it("makes audit_log read-only for every client role", () => {
    expect(sql).toMatch(/CREATE POLICY audit_log_select ON public\.audit_log\s+FOR SELECT USING \(has_capability\(account_id, 'audit\.view'\)\)/);
    expect(sql).not.toMatch(/CREATE POLICY \w+ ON public\.audit_log\s+FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(sql).toMatch(/REVOKE ALL ON public\.audit_log FROM PUBLIC, anon, authenticated, service_role/);
    expect(sql).toMatch(/GRANT SELECT ON public\.audit_log TO authenticated, service_role/);
  });

  it("raises on UPDATE, DELETE and TRUNCATE", () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.audit_log/);
    expect(sql).toMatch(/BEFORE TRUNCATE ON public\.audit_log/);
  });

  it("only log_audit writes, and clients cannot call it", () => {
    expect(sql.match(/INSERT INTO audit_log/g)?.length).toBe(1);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.log_audit\([^)]*\)\s+FROM PUBLIC, anon, authenticated, service_role/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.log_audit\([\s\S]*?SECURITY DEFINER\s+SET search_path = public/);
  });

  it("has no foreign keys on the log, so it survives account and user deletion", () => {
    const table = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS public.audit_log"), sql.indexOf("CREATE INDEX IF NOT EXISTS idx_audit_log_account_time"));
    expect(table).not.toMatch(/REFERENCES/);
  });

  it("creates the three indexes the screens read by", () => {
    expect(sql).toMatch(/idx_audit_log_account_time\s+ON public\.audit_log \(account_id, created_at DESC\)/);
    expect(sql).toMatch(/idx_audit_log_account_entity\s+ON public\.audit_log \(account_id, entity_type, entity_id, created_at DESC\)/);
    expect(sql).toMatch(/idx_audit_log_account_actor\s+ON public\.audit_log \(account_id, actor_id, created_at DESC\)/);
  });

  it("guards every trigger function so logging can never block a write", () => {
    const fns = sql.match(/CREATE OR REPLACE FUNCTION public\.audit_(row_change|article_change|link_change|team_member_change|profile_change|invitation_change|capability_change)\(\)[\s\S]*?\n\$\$;/g) ?? [];
    expect(fns.length).toBe(7);
    for (const fn of fns) expect(fn).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/);
  });

  it("soft-deletes tags, snippets and articles with a trigger that steps aside for cascades", () => {
    for (const table of ["tags", "quick_replies", "ai_knowledge_documents"]) {
      expect(sql).toMatch(new RegExp(`BEFORE DELETE ON public\\.${table}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.audit_soft_delete\\(`));
    }
    expect(sql).toMatch(/pg_trigger_depth\(\) > 1/);
  });

  it("hides soft-deleted rows from reads and from AI retrieval", () => {
    for (const policy of ["tags_select", "quick_replies_select", "ai_knowledge_documents_select"]) {
      expect(sql).toMatch(new RegExp(`CREATE POLICY ${policy} ON public\\.\\w+\\s+FOR SELECT USING \\(is_account_member\\(account_id\\) AND deleted_at IS NULL\\)`));
    }
    expect(sql.match(/AND d\.deleted_at IS NULL/g)?.length).toBe(2); // kb_match_fts + kb_match_semantic
  });

  it("lets a removed name be created again", () => {
    expect(sql).toMatch(/idx_tags_account_name_ci\s+ON public\.tags \(account_id, lower\(name\)\) WHERE deleted_at IS NULL/);
    expect(sql).toMatch(/ai_knowledge_documents_translation_uniq[\s\S]*?WHERE translation_of IS NOT NULL AND deleted_at IS NULL/);
  });

  it("never records a secret value for settings tables (names only)", () => {
    // Sensitive tables pass their columns as the NAMES-ONLY list (arg 3),
    // with an empty values list (arg 2).
    const settings = sql.match(/CREATE TRIGGER audit_row_change\s+AFTER INSERT OR UPDATE OR DELETE ON public\.(whatsapp_config|messenger_config|instagram_config|email_config|gmail_config|tiktok_config|web_widget_config|ai_configs|ai_connections|ai_task_routing|api_keys|webhook_endpoints)\s+FOR EACH ROW EXECUTE FUNCTION public\.audit_row_change\(([\s\S]*?)\);/g) ?? [];
    expect(settings.length).toBe(12);
    for (const trigger of settings) {
      const args = trigger.match(/audit_row_change\(([\s\S]*)\);/)![1];
      const parts = [...args.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      expect(parts[2], `values list must be empty: ${trigger}`).toBe("");
    }
  });

  it("gives the audit.view capability to owners and admins only", () => {
    expect(sql).toMatch(/\('audit\.view', 'agent', 'database'\)/);
    expect(sql).toMatch(/\('owner', 'audit\.view'\),\s+\('admin', 'audit\.view'\)/);
  });
});
