import { describe, expect, it } from "vitest";

import { readMigration } from "@/lib/testing/read-migration";

// A static read of migration 128. The live behaviour (reopen-clears-resolution,
// ticket_types CRUD, category guard, drilldown RPC, server-side search) is
// proven by supabase/ci/verify-128-ticket-followups.sql, a rolled-back DO block
// run against the real database; this pins the shape the app depends on so an
// edit that drops a guard or renames a column fails in CI, not in production.

const sql = readMigration("128_ticket_followups.sql");

function fn(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const next = sql.indexOf("CREATE OR REPLACE FUNCTION public.", start + 10);
  return sql.slice(start, next === -1 ? undefined : next);
}

describe("migration 128: reopening a ticket clears its resolution", () => {
  it("tickets_resolution_guard now empties resolution_id and resolution_note on reopen", () => {
    const guard = fn("tickets_resolution_guard");
    expect(guard).toMatch(/OLD\.status IN \('resolved', 'closed'\) AND NEW\.status NOT IN \('resolved', 'closed'\)/);
    expect(guard).toContain("NEW.resolution_id := NULL");
    expect(guard).toContain("NEW.resolution_note := NULL");
  });

  it("the existing resolution_required and resolution_invalid checks are still present", () => {
    const guard = fn("tickets_resolution_guard");
    expect(guard).toContain("RAISE EXCEPTION 'resolution_required'");
    expect(guard).toContain("RAISE EXCEPTION 'resolution_invalid'");
    expect(guard).toContain("NEW.status IN ('resolved', 'closed')");
  });
});

describe("migration 128: ticket_types catalogue", () => {
  it("has the columns the app reads", () => {
    for (const col of ["account_id", "slug", "name", "position", "is_active", "is_system", "created_at", "updated_at"]) {
      expect(sql, col).toMatch(new RegExp(`\\n  ${col}\\s+(UUID|TEXT|INTEGER|BOOLEAN|TIMESTAMPTZ)`));
    }
    expect(sql).toMatch(/CHECK \(slug ~ '\^/);
    expect(sql).toMatch(/CHECK \(char_length\(btrim\(name\)\) BETWEEN 1 AND 80\)/);
  });

  it("two active types cannot share a slug or a name within the same account", () => {
    expect(sql).toMatch(
      /UNIQUE INDEX IF NOT EXISTS uq_ticket_types_account_slug\s+ON public\.ticket_types \(account_id, slug\) WHERE is_active/,
    );
    expect(sql).toMatch(
      /UNIQUE INDEX IF NOT EXISTS uq_ticket_types_account_name\s+ON public\.ticket_types \(account_id, lower\(btrim\(name\)\)\) WHERE is_active/,
    );
  });

  it("row level security is on, members read, nobody deletes", () => {
    expect(sql).toMatch(/ALTER TABLE public\.ticket_types ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(
      /CREATE POLICY ticket_types_select ON public\.ticket_types\s+FOR SELECT\s+USING \(public\.is_account_member\(account_id\)\)/,
    );
    expect(sql).not.toMatch(/CREATE POLICY \w+ ON public\.ticket_types\s+FOR (DELETE|ALL)/);
    expect(sql).toMatch(/REVOKE DELETE, TRUNCATE ON public\.ticket_types FROM authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON public\.ticket_types FROM PUBLIC, anon/);
  });

  it("insert and update require the tickets.configure-form capability", () => {
    // Each policy block contains its capability check; easiest to verify by slicing
    const insertStart = sql.indexOf("CREATE POLICY ticket_types_insert ON public.ticket_types");
    const updateStart = sql.indexOf("CREATE POLICY ticket_types_update ON public.ticket_types");
    const insertEnd = sql.indexOf("CREATE POLICY", insertStart + 10);
    const insertBlock = sql.slice(insertStart, insertEnd === -1 ? undefined : insertEnd);
    const updateEnd = sql.indexOf("-- No DELETE", updateStart);
    const updateBlock = sql.slice(updateStart, updateEnd === -1 ? undefined : updateEnd);
    expect(insertStart, "ticket_types_insert policy exists").toBeGreaterThan(-1);
    expect(updateStart, "ticket_types_update policy exists").toBeGreaterThan(-1);
    expect(insertBlock).toContain("capability_account_ids('tickets.configure-form')");
    expect(updateBlock).toContain("capability_account_ids('tickets.configure-form')");
  });

  it("is seeded with the seven original slugs, for every account", () => {
    const seed = fn("ticket_types_seed");
    for (const slug of ["bug", "feature_request", "technical", "billing", "account", "general", "other"]) {
      expect(seed, slug).toContain(`'${slug}'`);
    }
    expect(sql).toMatch(/CREATE TRIGGER on_account_seed_ticket_types\s+AFTER INSERT ON public\.accounts/);
    expect(sql).toMatch(/FOR a IN SELECT id FROM public\.accounts LOOP\s+PERFORM public\.ticket_types_seed\(a\.id\)/);
  });

  it("a person cannot make a system type, archive one, or change its slug", () => {
    const guard = fn("ticket_types_guard");
    expect(guard).toContain("current_user <> 'authenticated'");
    expect(guard).toContain("NEW.is_system := false");
    expect(guard).toContain("OLD.is_system AND NOT NEW.is_active");
    expect(guard).toContain("system_type_locked");
  });

  it("a person's changes are audited, the seeding is not", () => {
    expect(sql).toMatch(
      /audit_row_change\s+AFTER INSERT OR UPDATE OR DELETE ON public\.ticket_types\s+FOR EACH ROW WHEN \(auth\.uid\(\) IS NOT NULL\)/,
    );
    expect(sql).toContain("'ticket_type', 'name', 'name,slug,is_active'");
  });
});

describe("migration 128: the category guard", () => {
  it("drops the hardcoded CHECK and replaces it with a trigger against the live catalogue", () => {
    expect(sql).toContain("ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_category_check");
    const guard = fn("tickets_category_guard");
    expect(guard).toContain("current_user <> 'authenticated'");
    expect(guard).toContain("ty.account_id = NEW.account_id AND ty.slug = NEW.category AND ty.is_active");
    expect(guard).toContain("RAISE EXCEPTION 'ticket_type_invalid'");
  });
});

describe("migration 128: reports drill-down RPC", () => {
  it("ticket_reports_drilldown returns oldestOpen and byLabel", () => {
    const drilldown = fn("ticket_reports_drilldown");
    expect(drilldown).toContain("p_account uuid");
    expect(drilldown).toContain("p_from");
    expect(drilldown).toContain("p_to");
    expect(drilldown).toContain("RETURNS jsonb");
    expect(drilldown).toContain("oldestOpen");
    expect(drilldown).toContain("byLabel");
    expect(drilldown).toContain("STABLE");
  });

  it("oldest-open tickets are active (open/in_progress/pending), ordered oldest-first", () => {
    const drilldown = fn("ticket_reports_drilldown");
    expect(drilldown).toContain("status IN ('open', 'in_progress', 'pending')");
    expect(drilldown).toContain("ORDER BY o.created_at ASC");
  });
});

describe("migration 128: server-side search RPC", () => {
  it("tickets_search exists and returns id + total_count", () => {
    const search = fn("tickets_search");
    expect(search).toContain("p_account");
    expect(search).toContain("RETURNS TABLE (id uuid, total_count bigint)");
    expect(search).toContain("STABLE");
  });

  it("supports all filter dimensions", () => {
    const search = fn("tickets_search");
    expect(search).toContain("p_search_text");
    expect(search).toContain("p_statuses");
    expect(search).toContain("p_assignees");
    expect(search).toContain("p_types");
    expect(search).toContain("p_priorities");
    expect(search).toContain("p_labels");
    expect(search).toContain("p_teams");
    expect(search).toContain("p_resolutions");
    expect(search).toContain("p_quick");
    expect(search).toContain("p_sort_key");
    expect(search).toContain("p_sort_dir");
    expect(search).toContain("p_limit");
    expect(search).toContain("p_offset");
  });

  it("quick filters: mine, unassigned, overdue, today, sla_at_risk, sla_breached are all handled", () => {
    const search = fn("tickets_search");
    for (const chip of ["mine", "unassigned", "overdue", "today", "sla_at_risk", "sla_breached"]) {
      expect(search, chip).toContain(`'${chip}'`);
    }
    // 'mentioned' is intentionally NOT in the SQL (it stays client-side)
    const bodyStart = search.indexOf("RETURN QUERY EXECUTE");
    expect(search.slice(bodyStart)).not.toContain("'mentioned'");
  });

  it("SLA helpers used by the search and sort are defined", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.ticket_sla_target_display(");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.ticket_sla_due_sort(");
  });
});

describe("migration 128: security", () => {
  it("every SECURITY DEFINER function pins its search path", () => {
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?\$\$;/g)) {
      const head = m[0].slice(0, m[0].indexOf("AS $$"));
      if (/SECURITY DEFINER/.test(head)) expect(head, m[1]).toContain("SET search_path = public");
    }
  });

  it("internal functions are not callable by clients", () => {
    for (const name of [
      "ticket_types_guard()",
      "ticket_types_seed(uuid)",
      "ticket_types_seed_new_account()",
      "tickets_category_guard()",
    ]) {
      expect(sql, name).toContain(`REVOKE ALL ON FUNCTION public.${name} FROM PUBLIC, anon, authenticated`);
    }
  });

  it("tickets_search and ticket_reports_drilldown are revoked from anon", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.tickets_search\([\s\S]*?\) FROM PUBLIC, anon/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.ticket_reports_drilldown\([\s\S]*?\) FROM PUBLIC, anon/);
  });

  it("is idempotent where it creates things", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.ticket_types");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_types_account_slug");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_types_account_name");
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS ticket_types_guard/);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS tickets_category_guard/);
  });
});
