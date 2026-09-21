import { describe, expect, it } from "vitest";

import { readMigration } from "@/lib/testing/read-migration";

// A static read of migration 096. The live behaviour (the rule for people, the
// system writers, Jira, mention resolution, RLS) is proven by
// supabase/ci/verify-096-ticket-resolutions.sql, a rolled-back DO block run against
// the real database; this pins the shape the app depends on, so an edit that
// drops a guard fails in CI, not in production.

const sql = readMigration("096_ticket_resolutions.sql");

function fn(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const next = sql.indexOf("CREATE OR REPLACE FUNCTION public.", start + 10);
  return sql.slice(start, next === -1 ? undefined : next);
}

describe("migration 096: the catalogue", () => {
  it("has the columns the app reads", () => {
    for (const col of ["account_id", "name", "position", "is_active", "is_system", "system_key", "created_at", "updated_at"]) {
      expect(sql, col).toMatch(new RegExp(`\\n  ${col}\\s+(UUID|TEXT|INTEGER|BOOLEAN|TIMESTAMPTZ)`));
    }
    expect(sql).toContain("CHECK (system_key IN ('resolved_in_jira', 'closed_automatically'))");
    expect(sql).toMatch(/CHECK \(char_length\(btrim\(name\)\) BETWEEN 1 AND 80\)/);
  });

  it("two active resolutions cannot share a name, and each account has one of each system entry", () => {
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS uq_ticket_resolutions_account_name\s+ON public\.ticket_resolutions \(account_id, lower\(btrim\(name\)\)\) WHERE is_active/);
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS uq_ticket_resolutions_system_key\s+ON public\.ticket_resolutions \(account_id, system_key\) WHERE system_key IS NOT NULL/);
  });

  it("row level security is on, members read, nobody deletes", () => {
    expect(sql).toMatch(/ALTER TABLE public\.ticket_resolutions ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY ticket_resolutions_select ON public\.ticket_resolutions\s+FOR SELECT\s+USING \(public\.is_account_member\(account_id\)\)/);
    expect(sql).not.toMatch(/CREATE POLICY \w+ ON public\.ticket_resolutions\s+FOR (DELETE|ALL)/);
    expect(sql).toMatch(/REVOKE DELETE, TRUNCATE ON public\.ticket_resolutions FROM authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON public\.ticket_resolutions FROM PUBLIC, anon/);
  });

  it("is seeded with the eight defaults, two of them system ones, for every account", () => {
    const seed = fn("ticket_resolutions_seed");
    for (const name of [
      "Fixed", "Answered / information given", "Duplicate", "Cannot reproduce", "Won''t fix",
      "Customer did not respond", "Resolved in Jira", "Closed automatically",
    ]) {
      expect(seed, name).toContain(`'${name}'`);
    }
    expect(seed).toContain("'resolved_in_jira'");
    expect(seed).toContain("'closed_automatically'");
    expect(sql).toMatch(/CREATE TRIGGER on_account_seed_ticket_resolutions\s+AFTER INSERT ON public\.accounts/);
    expect(sql).toMatch(/FOR a IN SELECT id FROM public\.accounts LOOP\s+PERFORM public\.ticket_resolutions_seed\(a\.id\)/);
  });

  it("a person cannot make a system resolution, archive one, or move a row between accounts", () => {
    const guard = fn("ticket_resolutions_guard");
    expect(guard).toContain("current_user <> 'authenticated'");
    expect(guard).toContain("NEW.is_system := false");
    expect(guard).toContain("OLD.is_system AND NOT NEW.is_active");
    expect(guard).toContain("system_resolution_locked");
  });

  it("a person's changes are audited, the seeding is not", () => {
    expect(sql).toMatch(/audit_row_change\s+AFTER INSERT OR UPDATE OR DELETE ON public\.ticket_resolutions\s+FOR EACH ROW WHEN \(auth\.uid\(\) IS NOT NULL\)/);
    expect(sql).toContain("'ticket_resolution', 'name', 'name,is_active'");
    expect(sql).toContain("'ticket_settings'");
  });
});

describe("migration 096: the rule", () => {
  it("the setting is on by default and only tickets.configure-form changes it", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS require_ticket_resolution BOOLEAN NOT NULL DEFAULT true/);
    expect(fn("accounts_capability_guard")).toContain("tickets.configure-form");
  });

  it("tickets carry the resolution and a note of at most 2000 characters that needs a resolution", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS resolution_id UUID REFERENCES public\.ticket_resolutions\(id\)/);
    expect(sql).not.toMatch(/resolution_id UUID REFERENCES public\.ticket_resolutions\(id\) ON DELETE/);
    expect(sql).toMatch(/char_length\(resolution_note\) <= 2000/);
    expect(sql).toMatch(/resolution_note IS NULL OR resolution_id IS NOT NULL/);
  });

  it("people are rejected with resolution_required; system writers get a default", () => {
    const guard = fn("tickets_resolution_guard");
    expect(guard).toContain("current_user = 'authenticated'");
    expect(guard).toContain("RAISE EXCEPTION 'resolution_required' USING ERRCODE = '22023'");
    expect(guard).toContain("RAISE EXCEPTION 'resolution_invalid' USING ERRCODE = '22023'");
    expect(guard).toContain("NEW.status IN ('resolved', 'closed')");
    expect(guard).toContain("'resolved_in_jira'");
    expect(guard).toContain("'closed_automatically'");
    expect(guard).toContain("vircle.source");
    expect(guard).not.toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/CREATE TRIGGER tickets_resolution_guard\s+BEFORE INSERT OR UPDATE ON public\.tickets/);
  });

  it("re-opening clears nothing: no trigger or function empties the resolution", () => {
    expect(sql).not.toMatch(/resolution_id\s*=\s*NULL/);
  });

  it("the history has resolved_as and resolution_changed, written by a trigger of its own", () => {
    expect(sql).toContain("ARRAY['resolved_as', 'resolution_changed']");
    expect(fn("log_ticket_resolution")).toContain("'resolved_as'");
    expect(sql).toMatch(/CREATE TRIGGER on_ticket_resolution_activity\s+AFTER UPDATE ON public\.tickets/);
    // log_ticket_activity (085) is left alone
    expect(sql).not.toContain("FUNCTION public.log_ticket_activity(");
  });
});

describe("migration 096: Jira and privileges", () => {
  it("jira_apply_ticket_status takes the resolution and falls back to Resolved in Jira", () => {
    const f = fn("jira_apply_ticket_status");
    expect(f).toContain("p_resolution_id uuid DEFAULT NULL");
    expect(f).toContain("ticket_system_resolution(v_account, 'resolved_in_jira')");
    expect(f).toContain("r.account_id = v_account AND r.is_active");
    expect(f).toContain("set_config('vircle.source', 'jira', true)");
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.jira_apply_ticket_status(uuid, text, text);");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.jira_apply_ticket_status\(uuid, text, text, uuid\) FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.jira_apply_ticket_status\(uuid, text, text, uuid\) TO service_role/);
  });

  it("every SECURITY DEFINER function pins its search path, and internal functions are not callable by clients", () => {
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?\$\$;/g)) {
      const head = m[0].slice(0, m[0].indexOf("AS $$"));
      if (/SECURITY DEFINER/.test(head)) expect(head, m[1]).toContain("SET search_path = public");
    }
    for (const name of [
      "ticket_resolutions_guard()", "ticket_resolutions_seed(uuid)", "ticket_resolutions_seed_new_account()",
      "ticket_system_resolution(uuid, text)", "audit_ticket_resolution_setting()",
      "tickets_resolution_guard()", "log_ticket_resolution()", "accounts_capability_guard()",
    ]) {
      expect(sql, name).toContain(`REVOKE ALL ON FUNCTION public.${name} FROM PUBLIC, anon, authenticated`);
    }
  });

  it("is idempotent where it creates things", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.ticket_resolutions");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS require_ticket_resolution");
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS tickets_resolution_guard/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS on_ticket_resolution_activity/);
  });
});
