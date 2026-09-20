import { describe, expect, it } from "vitest";

import { readMigration } from "@/lib/testing/read-migration";

import { DIRECTION_KEYS, DEFAULT_JIRA_SETTINGS } from "./types";
import type { JobKind } from "./store";

// A static read of migration 087. The live behaviour is proven by
// supabase/ci/verify-087-jira-depth.sql (a rolled-back DO block against the
// real database); this pins the shape the app depends on, so an edit that
// drops a guard fails in CI, not in production.

const sql = readMigration("087_jira_depth.sql");

function fn(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const next = sql.indexOf("CREATE OR REPLACE FUNCTION public.", start + 10);
  return sql.slice(start, next === -1 ? undefined : next);
}

const NEW_TABLES = ["jira_attachment_map", "jira_field_mappings", "jira_field_meta_cache", "jira_bulk_batches", "jira_bulk_items"];

describe("migration 087: tables and access", () => {
  for (const t of NEW_TABLES) {
    it(`${t} has row level security on and no client write policy`, () => {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
      expect(sql).not.toMatch(new RegExp(`CREATE POLICY \\w+ ON public\\.${t}\\s+FOR (INSERT|UPDATE|DELETE|ALL)`));
    });
  }

  it("the metadata cache has no policy and is closed to every client role", () => {
    expect(sql).not.toMatch(/CREATE POLICY \w+ ON public\.jira_field_meta_cache/);
    expect(sql).toMatch(/REVOKE ALL ON public\.jira_field_meta_cache FROM PUBLIC, anon, authenticated;/);
  });

  it("clients can only SELECT: members read the attachment map, mappings need jira.connect, bulk needs jira.link", () => {
    expect(sql).toMatch(/CREATE POLICY jira_attachment_map_select ON public\.jira_attachment_map\s+FOR SELECT USING \(is_account_member\(account_id\)\)/);
    expect(sql).toMatch(/CREATE POLICY jira_field_mappings_select ON public\.jira_field_mappings\s+FOR SELECT USING \(has_capability\(account_id, 'jira.connect'\)\)/);
    for (const t of ["jira_bulk_batches", "jira_bulk_items"]) {
      expect(sql).toMatch(new RegExp(`CREATE POLICY ${t}_select ON public\\.${t}\\s+FOR SELECT USING \\(has_capability\\(account_id, 'jira.link'\\)\\)`));
    }
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON[\s\S]*?jira_attachment_map[\s\S]*?FROM PUBLIC, anon, authenticated;/);
  });

  it("the attachment map prevents duplicates and echo", () => {
    expect(sql).toContain("UNIQUE (link_id, jira_attachment_id)");
    expect(sql).toMatch(/idx_jira_attachment_map_note[\s\S]*?\(link_id, ticket_attachment_id\)[\s\S]*?status = 'synced'/);
    expect(sql).toMatch(/idx_jira_attachment_map_hash[\s\S]*?\(link_id, content_hash\)[\s\S]*?status = 'synced'/);
    for (const s of ["synced", "skipped_type", "skipped_size", "skipped_cap", "failed", "duplicate"]) expect(sql).toContain(`'${s}'`);
  });

  it("a mapping is unique per project and ticket field, and belongs to one workspace", () => {
    expect(sql).toContain("UNIQUE (connection_id, project_key, ticket_field_id)");
    expect(fn("jira_field_mapping_guard")).toContain("v_field_acct <> NEW.account_id");
    expect(sql).toMatch(/CREATE TRIGGER jira_field_mapping_guard BEFORE INSERT OR UPDATE ON public\.jira_field_mappings/);
  });

  it("bulk actions are capped at 25 in the database too", () => {
    expect(sql).toMatch(/total\s+INTEGER NOT NULL CHECK \(total BETWEEN 1 AND 25\)/);
  });
});

describe("migration 087: rules in the database", () => {
  it("a client cannot claim a file came from Jira", () => {
    const body = fn("ticket_attachment_source_guard");
    expect(body).toContain("auth.uid() IS NOT NULL");
    expect(body).toContain("NEW.source := 'vircle'");
    expect(body).toContain("NEW.source := OLD.source");
    expect(sql).toMatch(/CREATE TRIGGER ticket_attachment_source_guard BEFORE INSERT OR UPDATE ON public\.ticket_attachments/);
  });

  it("a value that came from Jira never queues an outbound push, and a file from Jira is never queued", () => {
    expect(fn("jira_queue_field_push")).toContain("current_setting('vircle.source', true)");
    expect(fn("jira_apply_ticket_fields")).toContain("set_config('vircle.source', 'jira', true)");
    expect(fn("jira_queue_attachment_push")).toContain("NEW.source = 'jira'");
    expect(fn("jira_queue_status_push")).toContain("current_setting('vircle.source', true)");
  });

  it("the triggers read the same settings keys the app writes", () => {
    for (const key of ["attachments", "attachments_auto", "status_to_jira"]) expect(Object.keys(DEFAULT_JIRA_SETTINGS.direction)).toContain(key);
    expect(fn("jira_queue_attachment_push")).toContain("'direction' ->> 'attachments_auto'");
    expect(fn("jira_queue_status_push")).toContain("'project_overrides'");
    expect(fn("jira_queue_attachment_push")).toContain("'project_overrides'");
    expect([...DIRECTION_KEYS]).toEqual(expect.arrayContaining(["attachments", "attachments_auto"]));
  });

  it("the field push waits a few seconds so a burst of edits is one write", () => {
    expect(fn("jira_queue_field_push")).toMatch(/'fields:' \|\| NEW\.id::text, 5\)/);
    expect(sql).toMatch(/CREATE TRIGGER jira_field_push AFTER UPDATE OF custom_fields ON public\.tickets/);
  });

  it("the stall alert is once a day per person and only for an active connection", () => {
    const body = fn("jira_notify_stalled");
    expect(body).toContain("interval '24 hours'");
    expect(body).toContain("c.status <> 'active'");
    expect(body).toContain("'jira_sync_stalled'");
  });
});

describe("migration 087: every function is closed to clients", () => {
  const SERVICE_ONLY = [
    ["jira_bump_webhook_stat", "uuid, text"],
    ["jira_apply_ticket_fields", "uuid, jsonb"],
    ["jira_notify_stalled", "uuid, integer"],
    ["jira_prune", ""],
  ] as const;

  for (const [name, sig] of SERVICE_ONLY) {
    it(`${name} is SECURITY DEFINER, pinned to public, not executable by clients, executable by the service role`, () => {
      const body = fn(name);
      expect(body).toContain("SECURITY DEFINER");
      expect(body).toContain("SET search_path = public");
      const s = sig.replace(/[()]/g, "\\$&");
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(${s}\\)\\s+FROM PUBLIC, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(${s}\\)\\s+TO service_role;`));
    });
  }

  it("the trigger functions are not callable by clients", () => {
    for (const f of ["jira_queue_field_push()", "jira_queue_attachment_push()", "jira_queue_status_push()", "ticket_attachment_source_guard()", "jira_field_mapping_guard()"]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${f}`);
    }
  });
});

describe("migration 087: the app and the SQL agree", () => {
  it("the job kinds the database accepts are exactly the ones the worker handles, rebuilt from the live definition", () => {
    const kinds: JobKind[] = ["sync_issue", "push_status", "post_comment", "edit_comment", "push_fields", "push_attachment", "pull_attachments", "bulk_item"];
    for (const k of kinds) expect(sql).toContain(`'${k}'`);
    expect(sql).toMatch(/pg_get_constraintdef\(oid\) ILIKE '%kind%'/);
    expect(sql).toContain("public.jira_check_values_087(c.def)");
  });

  it("widens the notification CHECK from the live definition (every earlier value kept) and adds jira_sync_stalled", () => {
    expect(sql).toContain("'jira_sync_stalled'");
    expect(sql).toMatch(/v_types := public\.jira_check_values_087\(v_def\)/);
    // no hard-coded copy of the old list: none of the earlier types appears in the migration
    for (const old of ["conversation_assigned", "ticket_mention", "approval_requested", "jira_reauth_required", "jira_issue_done"]) expect(sql).not.toContain(`'${old}'`);
    expect(sql).toContain("string_to_array(replace(btrim(m[1], '{}')");
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.jira_check_values_087\(text\);\s*$/);
  });

  it("does not touch or depend on the SLA migration's objects, nor the chat-media bucket", () => {
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/sla|_sla|business_hours/i);
    expect(sql).not.toContain("storage.buckets");
    expect(sql).not.toContain("allowed_mime_types");
  });

  it("is idempotent in style", () => {
    expect(sql).not.toMatch(/^CREATE TABLE (?!IF NOT EXISTS)/m);
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(sql).toContain("DROP TRIGGER IF EXISTS");
  });
});
