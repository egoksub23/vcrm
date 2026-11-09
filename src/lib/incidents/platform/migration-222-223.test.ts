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
