import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AUDIT_ENTITY_TYPES } from "@/lib/audit/types";
import { readMigration } from "@/lib/testing/read-migration";

import { ADD_CASES, BETWEEN_CASES, FIXTURE_SCHEDULES } from "./business-time.fixtures";

// A static read of migration 086 and its verify script. The live behaviour is
// proven by supabase/ci/verify-086-ticket-sla.sql (a rolled-back DO block against
// the real database); this pins the shape the app depends on and, above all, that
// the SQL verify script asserts EXACTLY the fixtures the TypeScript tests assert,
// so the two implementations of the business-hours maths cannot drift apart.

const sql = readMigration("086_ticket_sla.sql");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-086-ticket-sla.sql"), "utf8");

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

describe("parity: the verify script carries the TypeScript fixtures", () => {
  it("has every schedule of the fixtures, with the same zone, weekly hours and holidays", () => {
    for (const [key, s] of Object.entries(FIXTURE_SCHEDULES)) {
      const row = `(${q(key)}, ${q(s.timezone)}, ${q(JSON.stringify(s.weekly))}::jsonb, ARRAY[${(s.holidays ?? []).map(q).join(",")}]::text[])`;
      expect(verify, key).toContain(row);
    }
  });

  it("has every add case with the same start, minutes and answer", () => {
    for (const c of ADD_CASES) {
      const row = `(${q(c.name)}, ${c.schedule === null ? "NULL" : q(c.schedule)}, ${q(c.from)}, ${c.minutes}, ${c.expected === null ? "NULL" : q(c.expected)})`;
      expect(verify, c.name).toContain(row);
    }
  });

  it("has every between case with the same range and answer", () => {
    for (const c of BETWEEN_CASES) {
      const row = `(${q(c.name)}, ${c.schedule === null ? "NULL" : q(c.schedule)}, ${q(c.from)}, ${q(c.to)}, ${c.expected === null ? "NULL" : c.expected})`;
      expect(verify, c.name).toContain(row);
    }
  });

  it("ends in a rollback and never commits", () => {
    expect(verify).toMatch(/RAISE EXCEPTION 'ROLLBACK-OK: /);
    expect(verify).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});

describe("migration 086: what the app depends on", () => {
  it("adds sla.configure at the database tier for Owner and Admin", () => {
    expect(sql).toMatch(/\('sla\.configure', 'agent', 'database'\)/);
    expect(sql).toMatch(/\('owner', 'sla\.configure'\)/);
    expect(sql).toMatch(/\('admin', 'sla\.configure'\)/);
    expect(sql).not.toMatch(/\('(agent|viewer)', 'sla\.configure'\)/);
  });

  for (const t of ["business_hours_schedules", "business_hours_holidays", "ticket_sla_policies"]) {
    it(`${t}: row level security, members read, sla.configure writes`, () => {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
      expect(sql).toMatch(new RegExp(`CREATE POLICY ${t}_select ON public\\.${t}\\s+FOR SELECT USING \\(is_account_member\\(account_id\\)\\)`));
      for (const [verb, clause] of [
        ["insert", "FOR INSERT WITH CHECK"],
        ["update", "FOR UPDATE USING"],
        ["delete", "FOR DELETE USING"],
      ]) {
        expect(sql, `${t}_${verb}`).toMatch(
          new RegExp(`CREATE POLICY ${t}_${verb} ON public\\.${t}\\s+${clause} \\(has_capability\\(account_id, 'sla\\.configure'\\)\\)`),
        );
      }
    });
  }

  it("exactly one default schedule per account (partial unique index)", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_bh_schedules_one_default\s+ON public\.business_hours_schedules \(account_id\) WHERE is_default/);
  });

  it("a schedule a policy uses cannot be deleted", () => {
    expect(sql).toMatch(/schedule_id\s+UUID REFERENCES public\.business_hours_schedules\(id\) ON DELETE RESTRICT/);
  });

  it("policy limits: targets, ordering, at-risk 50..95", () => {
    expect(sql).toContain("ticket_sla_policies_has_target");
    expect(sql).toMatch(/resolution_minutes > first_response_minutes/);
    expect(sql).toMatch(/at_risk_percent\s+INTEGER NOT NULL DEFAULT 80 CHECK \(at_risk_percent BETWEEN 50 AND 95\)/);
  });

  it("the business-time functions exist as INVOKER functions with the documented signatures", () => {
    expect(sql).toMatch(/FUNCTION public\.sla_add_business_minutes\(\s*p_schedule_id uuid,\s*p_from\s+timestamptz,\s*p_minutes\s+integer\s*\)/);
    expect(sql).toMatch(/FUNCTION public\.sla_business_minutes_between\(\s*p_schedule_id uuid,\s*p_from\s+timestamptz,\s*p_to\s+timestamptz\s*\)/);
    const add = sql.slice(sql.indexOf("FUNCTION public.sla_add_business_seconds("), sql.indexOf("FUNCTION public.sla_business_seconds_between("));
    expect(add).not.toMatch(/SECURITY DEFINER/);
    expect(add).toMatch(/FOR v_k IN 0\.\.365 LOOP/); // 366 local days, then stop
    expect(add).toMatch(/RAISE WARNING 'sla_add_business_seconds: not enough open time within 366 days/);
  });

  it("the ticket trigger never blocks a write and keeps clients out of the SLA columns", () => {
    const trig = sql.slice(sql.indexOf("FUNCTION public.ticket_sla_state()"), sql.indexOf("DROP TRIGGER IF EXISTS ticket_sla_state"));
    expect(trig).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'ticket_sla_state failed/);
    expect(trig).toMatch(/pg_trigger_depth\(\) > 1/);
    expect(trig).toMatch(/vircle\.sla_internal/);
    expect(sql).toMatch(/CREATE TRIGGER ticket_sla_state\s+BEFORE INSERT OR UPDATE ON public\.tickets/);
  });

  it("first response is the first non-Jira comment written by a person, recorded once", () => {
    const fr = sql.slice(sql.indexOf("FUNCTION public.ticket_sla_first_response()"), sql.indexOf("DROP TRIGGER IF EXISTS ticket_sla_first_response"));
    expect(fr).toMatch(/NEW\.author_id IS NULL OR COALESCE\(to_jsonb\(NEW\) ->> 'source', 'vircle'\) <> 'vircle'/);
    expect(fr).toMatch(/AND sla_first_response_at IS NULL/);
  });

  it("the notification CHECK is rebuilt from the live definition and adds the two types plus sla_breach", () => {
    expect(sql).toMatch(/pg_get_constraintdef\(oid\) INTO v_def/);
    expect(sql).toMatch(/notifications_type_check/);
    for (const t of ["sla_breach", "ticket_sla_at_risk", "ticket_sla_breached"]) expect(sql).toContain(`'${t}'`);
    // no hard-coded list of the old values: it must not name any of them
    for (const old of ["approval_requested", "jira_issue_done", "ticket_updated", "ai_budget"]) {
      expect(sql, old).not.toContain(`'${old}'`);
    }
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.sla_check_values\(text\)/);
  });

  it("the sweep is service role only, batch limited and skips locked rows", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.sla_sweep\(integer\)\s+FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.sla_sweep\(integer\)\s+TO service_role;/);
    const sweep = sql.slice(sql.indexOf("FUNCTION public.sla_sweep("), sql.indexOf("FUNCTION public.sla_apply_to_open_tickets("));
    expect((sweep.match(/FOR UPDATE SKIP LOCKED/g) ?? []).length).toBe(2);
    expect(sweep).toMatch(/LIMIT p_limit/);
    expect(sweep).toMatch(/sla_fr_breach_notified_at IS NULL/);
  });

  it("apply-to-open and reorder check sla.configure inside the function", () => {
    for (const name of ["sla_apply_to_open_tickets", "sla_reorder_policies"]) {
      const body = sql.slice(sql.indexOf(`FUNCTION public.${name}(`));
      expect(body.slice(0, 900), name).toMatch(/has_capability\(p_account, 'sla\.configure'\)/);
    }
  });

  it("audits schedules, holidays and policies with the generic row trigger; position is not tracked", () => {
    for (const [table, type] of [
      ["business_hours_schedules", "business_hours"],
      ["business_hours_holidays", "business_hours_holiday"],
      ["ticket_sla_policies", "sla_policy"],
    ]) {
      expect(sql).toMatch(new RegExp(`CREATE TRIGGER audit_row_change\\s+AFTER INSERT OR UPDATE OR DELETE ON public\\.${table}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.audit_row_change\\(\\s+'${type}'`));
      expect(AUDIT_ENTITY_TYPES as readonly string[]).toContain(type);
    }
    const policyAudit = sql.slice(sql.indexOf("ON public.ticket_sla_policies\n  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change("));
    expect(policyAudit.slice(0, 400)).not.toMatch(/\bposition\b/);
  });

  it("is written to be run twice", () => {
    expect(sql).not.toMatch(/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX) (?!IF NOT EXISTS)/m);
    expect(sql).not.toMatch(/^\s*CREATE FUNCTION /m);
    for (const trigger of sql.matchAll(/^CREATE TRIGGER (\w+)\s+(?:BEFORE|AFTER)[^;]*?ON ([\w.]+)/gm)) {
      expect(sql, `${trigger[1]} on ${trigger[2]}`).toContain(`DROP TRIGGER IF EXISTS ${trigger[1]} ON ${trigger[2]};`);
    }
  });

  it("does not touch Jira objects, the conversation SLA or the chat-media bucket", () => {
    expect(sql).not.toMatch(/jira_/);
    expect(sql).not.toMatch(/sla_response_minutes|sla_notified_at|awaiting_response/);
    expect(sql).not.toMatch(/chat-media/);
  });
});
