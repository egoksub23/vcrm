import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(process.cwd(), "supabase", "migrations", name), "utf8").replace(/\r\n/g, "\n");

describe("migration 223 (findings, file removal, nobody could be told)", () => {
  const m = read("223_incident_triage_audit.sql");

  it("lets the activity trail record a root cause and a deleted file", () => {
    expect(m).toContain("'root_cause_changed', 'file_deleted'");
    expect(m).toContain("IF NEW.root_cause IS DISTINCT FROM OLD.root_cause THEN");
  });

  it("keeps every earlier kind of activity", () => {
    for (const k of ["created", "status_changed", "severity_changed", "type_changed", "lead_changed", "escalated", "closed"]) expect(m).toContain(`'${k}'`);
  });

  it("counts an incident nobody was ever asked to acknowledge, from when it was raised, and leaves tests out", () => {
    expect(m).toContain("LEFT JOIN public.incident_ack_state s ON s.incident_id = i.id");
    expect(m).toContain("COALESCE(s.first_ask_at, i.created_at) <= p_before");
    expect(m).toContain("AND NOT i.is_test");
    expect(m).toContain("AND i.status = 'reported'");
  });

  it("stays out of reach of ordinary users", () => {
    expect(m).toContain("REVOKE ALL ON FUNCTION public.incident_unacknowledged(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;");
    expect(m).toContain("GRANT EXECUTE ON FUNCTION public.incident_unacknowledged(UUID, TIMESTAMPTZ, INTEGER) TO service_role;");
  });
});

describe("migration 224 (findings, void and delete)", () => {
  const m = read("224_incident_findings_void.sql");
  it("marks a note as a finding", () => {
    expect(m).toContain("ADD COLUMN IF NOT EXISTS is_finding BOOLEAN NOT NULL DEFAULT FALSE");
  });
  it("records who voided an incident, when and why", () => {
    for (const c of ["voided_at", "voided_by", "void_reason"]) expect(m).toContain(`ADD COLUMN IF NOT EXISTS ${c}`);
  });
  it("keeps a deletion log that holds no personal details, readable by people who configure incidents and writable only by the server", () => {
    expect(m).toContain("CREATE TABLE IF NOT EXISTS public.incident_deletions");
    expect(m).toContain("FOR SELECT USING (has_capability(account_id, 'incidents.configure'))");
    expect(m).not.toMatch(/CREATE POLICY \w+ ON public\.incident_deletions FOR (INSERT|UPDATE|DELETE|ALL)/);
  });
  it("lets the activity trail say voided and restored, keeping every earlier kind", () => {
    expect(m).toContain("'voided', 'restored'");
    for (const k of ["created", "root_cause_changed", "file_deleted"]) expect(m).toContain(`'${k}'`);
  });
});

describe("migration 225 (escalation through roles and rules only)", () => {
  const m = read("225_incident_escalation_rules_only.sql");
  it("brings the old list across as contacts, roles, members and a rule for each level", () => {
    expect(m).toContain("INSERT INTO public.incident_contacts");
    expect(m).toContain("'escalation_level_' || r.level");
    expect(m).toContain("INSERT INTO public.incident_role_members");
    expect(m).toContain("'escalated_' || x.level");
  });
  it("leaves a school that wrote its own escalation rule exactly as it is", () => {
    expect(m.match(/NOT EXISTS \(SELECT 1 FROM public\.incident_rules e WHERE e\.account_id = [xa]\.account_id AND e\.trigger = 'escalated'\)/g)?.length).toBe(2);
  });
  it("gives a school with no old list the Principal at level 2 and the Principal and the lead at the top", () => {
    expect(m).toContain("'role_key', 'principal'");
    expect(m).toContain("'role_key', 'incident_lead'");
  });
  it("no longer tells anybody from the database: the functions only raise and record the level", () => {
    expect(m).not.toContain("INSERT INTO notifications");
    expect(m.match(/INSERT INTO incident_escalation_events/g)?.length).toBe(2);
    expect(m).toContain("DROP FUNCTION IF EXISTS public.incident_escalation_recipient_ids(UUID, INTEGER);");
  });
  it("keeps the old table, unused, so nothing is lost", () => {
    expect(m).not.toMatch(/DROP TABLE/);
  });
});

describe("migration 226 (a school's own statuses)", () => {
  const m = read("226_incident_custom_statuses.sql");
  it("maps every extra status to one of the six base statuses, and lets a built-in row only rename its own", () => {
    expect(m).toContain("base_status IN ('reported', 'triaged', 'contained', 'investigating', 'recovered', 'closed')");
    expect(m).toContain("CHECK (NOT is_builtin OR key = base_status)");
  });
  it("keeps the base status on the incident and the school's choice beside it", () => {
    expect(m).toContain("ALTER TABLE public.incidents ADD COLUMN IF NOT EXISTS status_key TEXT;");
  });
  it("is readable by everyone in the school and written only by the server", () => {
    expect(m).toContain("FOR SELECT USING (is_account_member(account_id))");
    expect(m).not.toMatch(/CREATE POLICY \w+ ON public\.incident_status_options FOR (INSERT|UPDATE|DELETE|ALL)/);
  });
});

describe("migration 227 (business hours for timed rules)", () => {
  const m = read("227_incident_business_hours.sql");
  it("lets a school choose one of its business-hours schedules", () => {
    expect(m).toContain("ADD COLUMN IF NOT EXISTS business_hours_schedule_id UUID REFERENCES public.business_hours_schedules(id) ON DELETE SET NULL");
  });
  it("replaces the three sweep functions (dropping the old signatures first) and counts the wait inside the hours only when a schedule is given", () => {
    expect(m.match(/DROP FUNCTION IF EXISTS/g)?.length).toBe(3);
    expect(m.match(/public\.sla_add_business_seconds\(p_schedule,/g)?.length).toBe(3);
    expect(m.match(/WHEN p_schedule IS NULL THEN/g)?.length).toBe(3);
  });
  it("stays out of reach of ordinary users", () => {
    expect(m.match(/REVOKE ALL ON FUNCTION/g)?.length).toBe(3);
    expect(m.match(/TO service_role;/g)?.length).toBe(3);
  });
});

describe("migration 228 (channels and email-in)", () => {
  const m = read("228_incident_channels_email_in.sql");
  it("keeps one settings row per school, with a unique secret address", () => {
    expect(m).toContain("account_id                UUID        PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE");
    expect(m).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_channel_settings_token");
  });
  it("is closed to everyone but people who configure incidents, because it holds the secret address", () => {
    expect(m).toContain("FOR SELECT USING (has_capability(account_id, 'incidents.configure'))");
    expect(m).not.toContain("is_account_member");
  });
  it("lets an incident come from an email", () => {
    expect(m).toContain("CHECK (source IN ('halo', 'coach_portal', 'api', 'email'))");
  });
});
