import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Static guards on migration 179 (a connected mailbox: use it for the customer care inbox, independently of pausing it): the properties that are easy to
// break by editing the SQL and that the rolled-back verification script (supabase/ci/verify-179-mailbox-inbox-switch.sql) proves against a database.

const migration = readFileSync(join(process.cwd(), "supabase", "migrations", "179_mailbox_inbox_switch.sql"), "utf8").replace(/\r\n/g, "\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-179-mailbox-inbox-switch.sql"), "utf8").replace(/\r\n/g, "\n");
const audit082 = readFileSync(join(process.cwd(), "supabase", "migrations", "082_audit_trail.sql"), "utf8");

describe("migration 179", () => {
  it("adds inbox_enabled to both mailbox tables as boolean NOT NULL DEFAULT true, so every mailbox connected before keeps receiving, idempotently", () => {
    expect(migration).toMatch(/ALTER TABLE public\.email_config ADD COLUMN IF NOT EXISTS inbox_enabled BOOLEAN NOT NULL DEFAULT true;/);
    expect(migration).toMatch(/ALTER TABLE public\.gmail_config ADD COLUMN IF NOT EXISTS inbox_enabled BOOLEAN NOT NULL DEFAULT true;/);
  });

  it("does not touch the master pause (enabled) beyond its comment, and never drops or rewrites data", () => {
    expect(migration).not.toMatch(/\bDROP COLUMN\b|\bDELETE FROM\b|\bTRUNCATE\b|\bUPDATE public\./i);
    expect(migration).not.toMatch(/ALTER COLUMN enabled/);
  });

  it("records the from/to of both switches in the audit trail and keeps the secret columns name-only, with no secret among the recorded values", () => {
    const triggers = [...migration.matchAll(/CREATE TRIGGER audit_row_change\s+AFTER INSERT OR UPDATE OR DELETE ON public\.(email_config|gmail_config)\s+FOR EACH ROW EXECUTE FUNCTION public\.audit_row_change\(([\s\S]*?)\);/g)];
    expect(triggers.map((t) => t[1])).toEqual(["email_config", "gmail_config"]);
    for (const t of triggers) {
      const parts = [...t[2].matchAll(/'([^']*)'/g)].map((m) => m[1]);
      expect(parts[2], `values list of ${t[1]}`).toBe("enabled,inbox_enabled");
      expect(parts[3], `names-only list of ${t[1]}`).toMatch(/refresh_token/);
      expect(parts[2]).not.toMatch(/token|secret|password/);
    }
    // 082's names-only lists are kept as they were
    expect(audit082).toContain("'mailbox_user_id,mailbox_address,refresh_token,status'");
    expect(migration).toContain("'mailbox_user_id,mailbox_address,refresh_token,status'");
    expect(migration).toContain("'email_address,refresh_token,pubsub_verify_token,status'");
    expect(migration).toMatch(/DROP TRIGGER IF EXISTS audit_row_change ON public\.email_config;/);
    expect(migration).toMatch(/DROP TRIGGER IF EXISTS audit_row_change ON public\.gmail_config;/);
  });

  it("counts a mailbox as a channel for the first-run checklist only while its inbox is on, and keeps the function's grants (members only, not signed-out callers)", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.onboarding_status\(p_account UUID\)/);
    expect(migration).toMatch(/t IN \('email_config', 'gmail_config'\) THEN ' AND c\.inbox_enabled'/);
    expect(migration).toMatch(/NOT public\.is_account_member\(p_account\)/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.onboarding_status\(UUID\) FROM PUBLIC, anon;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.onboarding_status\(UUID\) TO authenticated, service_role;/);
    expect(migration).toMatch(/SECURITY DEFINER\s+SET search_path = public/);
  });

  it("changes no policy or grant on the mailbox tables: any member reads, channels.manage writes (079), as before", () => {
    expect(migration).not.toMatch(/CREATE POLICY|DROP POLICY|GRANT .* ON public\.(email_config|gmail_config)|REVOKE .* ON public\.(email_config|gmail_config)/i);
  });

  it("is verified by a self-contained script that ends in the deliberate rollback", () => {
    expect(verify).toMatch(/^DO \$verify\$/m);
    expect(verify).toMatch(/RAISE EXCEPTION 'ROLLBACK-OK: /);
    expect(verify).toContain("FAIL");
  });
});
