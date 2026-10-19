import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readMigration } from "@/lib/testing/read-migration";

// Guards on the TEXT of migration 189 (an edit to a compliance request saves). The behaviour is proven against a database by
// supabase/ci/verify-189-compliance-edit-fix.sql (run it rolled back against production, with 189's text in front until it is applied).
// The bug: `v_changed := v_changed || 'customer_email'` appends an UNTYPED literal to a text[], which Postgres reads as an array literal and
// refuses (22P02). Nothing exercised an edit of a customer detail, so it was only found when someone saved one.

const dir = join(process.cwd(), "supabase", "migrations");
const sql = readMigration("189_compliance_edit_fix.sql").replace(/\r\n/g, "\n");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-189-compliance-edit-fix.sql"), "utf8").replace(/\r\n/g, "\n");

describe("migration 189", () => {
  it("appends each changed field with array_append, six times, and never `|| 'literal'` onto the list", () => {
    expect(code.match(/array_append\(v_changed, '[a-z_]+'\)/g)).toHaveLength(6);
    for (const f of ["customer_name", "customer_email", "customer_phone", "channel", "data", "sensitive_data"]) expect(code).toContain(`array_append(v_changed, '${f}')`);
    expect(code).not.toMatch(/v_changed\s*:=\s*v_changed\s*\|\|\s*'/);
  });

  it("replaces the one function and re-states its owner and privileges, changing nothing else", () => {
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(code).toContain("CREATE OR REPLACE FUNCTION public.compliance_update_request(p_request UUID, p_actor UUID, p_patch JSONB)");
    expect(code).toContain("SECURITY DEFINER");
    expect(code).toContain("SET search_path = public");
    expect(code).toContain("ALTER FUNCTION public.compliance_update_request(UUID, UUID, JSONB) OWNER TO postgres;");
    expect(code).toContain("REVOKE ALL ON FUNCTION public.compliance_update_request(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;");
    expect(code).toContain("GRANT EXECUTE ON FUNCTION public.compliance_update_request(UUID, UUID, JSONB) TO service_role;");
    expect(code).not.toMatch(/CREATE TABLE|ALTER TABLE|CREATE POLICY|DROP |CREATE TRIGGER|INSERT INTO/i);
  });

  it("is migration 183's function body, line for line, apart from the six appends (so nothing else about an edit can have drifted)", () => {
    const old = readMigration("183_compliance_requests.sql").replace(/\r\n/g, "\n");
    const body = (s: string) => {
      const from = s.indexOf("CREATE OR REPLACE FUNCTION public.compliance_update_request(");
      const to = s.indexOf("GRANT EXECUTE ON FUNCTION public.compliance_update_request(UUID, UUID, JSONB) TO service_role;");
      return s.slice(from, to);
    };
    const fixed = body(old)
      .replace(/v_changed := v_changed \|\| ('[a-z_]+');/g, "v_changed := array_append(v_changed, $1);");
    expect(body(sql)).toBe(fixed);
  });

  it("keeps the same list of editable keys as the screen and the route send", () => {
    for (const key of ["customer_name", "customer_email", "customer_phone", "channel", "contact_id", "conversation_id", "ticket_id", "incident_id", "kyc_validation_ref", "data", "data_enc", "assigned_to", "received_at"]) {
      expect(code).toContain(`'${key}'`);
    }
  });

  it("has a verify script that saves every editable key, ends in the deliberate rollback, and names the field not the value", () => {
    expect(verify).toContain("RAISE EXCEPTION 'ROLLBACK-OK:");
    for (const s of ["customer_email", "customer_phone", "sensitive_data", '"data"', "unknown_field", "bad_patch", "closed", "search_path"]) expect(verify, s).toContain(s);
  });

  it("is the only migration after 183 that touches that function, and no later one brings the bug back", () => {
    for (const f of readdirSync(dir).filter((n) => /^\d+_.*\.sql$/.test(n) && n !== "183_compliance_requests.sql")) {
      // comments are skipped: 189's own header quotes the bad line to explain it
      const text = readFileSync(join(dir, f), "utf8")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n");
      expect(text, f).not.toMatch(/v_changed\s*:=\s*v_changed\s*\|\|\s*'/);
    }
  });
});
