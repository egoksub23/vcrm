import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readMigration } from "@/lib/testing/read-migration";

// Guards on the TEXT of migration 190 (accepting an invitation deletes the invitee's empty personal workspace). The behaviour is proven against a
// database by supabase/ci/verify-190-invite-accept-purge-flag.sql (run it rolled back against production, with 190's text in front until it is
// applied). The bug: that delete cascades to the workspace's seeded Compliance system types, a guard (183) refuses to delete them unless
// `vircle.purge_account` names the workspace, and nothing set it, so EVERY accept by a new person failed with 23514 (the route answered a generic 500,
// "Failed to redeem invitation").

const sql = readMigration("190_invite_accept_purge_flag.sql").replace(/\r\n/g, "\n");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-190-invite-accept-purge-flag.sql"), "utf8").replace(/\r\n/g, "\n");

describe("migration 190", () => {
  it("names the personal workspace in the purge flag for that one delete, and clears it straight after", () => {
    const set = code.indexOf("PERFORM set_config('vircle.purge_account', v_old_account_id::text, true);");
    const del = code.indexOf("DELETE FROM accounts WHERE id = v_old_account_id;");
    const clear = code.indexOf("PERFORM set_config('vircle.purge_account', '', true);");
    expect(set).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(set);
    expect(clear).toBeGreaterThan(del);
    // transaction-local (the third argument), never session-wide
    expect(code.match(/set_config\('vircle\.purge_account'[^)]*\)/g)!.every((c) => c.endsWith("true)"))).toBe(true);
    // exactly one delete, and it is of the workspace the function just checked is empty
    expect(code.match(/DELETE FROM/g)).toHaveLength(1);
  });

  it("refuses, instead of destroying, a personal workspace that holds retained records: a Compliance case, a Secure Sign document, a KYC log row", () => {
    for (const t of ["compliance_requests", "sign_documents", "kyc_access_log"]) {
      expect(code).toContain(`SELECT 1 FROM ${t} WHERE account_id = v_old_account_id`);
    }
    // and the check runs before anything is moved or deleted
    expect(code.indexOf("kyc_access_log")).toBeLessThan(code.indexOf("IF v_has_data THEN RETURN 'has_data'; END IF;"));
    expect(code.indexOf("IF v_has_data THEN RETURN 'has_data'; END IF;")).toBeLessThan(code.indexOf("UPDATE profiles"));
    // the original eleven kinds of data are still checked
    for (const t of ["contacts", "conversations", "broadcasts", "automations", "flows", "pipelines", "message_templates", "tags", "custom_fields", "contact_notes", "whatsapp_config"]) {
      expect(code).toContain(`SELECT 1 FROM ${t} WHERE account_id = v_old_account_id`);
    }
  });

  it("is migration 114's function, line for line, apart from those two changes (the custom role, the teams and the audit all still ride along)", () => {
    const old = readMigration("114_custom_account_role_rpcs.sql").replace(/\r\n/g, "\n");
    const body = (s: string) => {
      const from = s.indexOf("CREATE OR REPLACE FUNCTION public.attach_user_to_invited_account(");
      const to = s.indexOf("REVOKE ALL ON FUNCTION public.attach_user_to_invited_account(UUID, UUID) FROM PUBLIC, anon, authenticated;");
      return s.slice(from, to);
    };
    const strip = (s: string) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .filter((l) => !/compliance_requests|sign_documents|kyc_access_log|purge_account/.test(l))
        .join("\n");
    expect(strip(body(sql))).toBe(strip(body(old)));
    expect(code).toContain("custom_role_id = v_inv.custom_role_id");
    expect(code).toContain("INSERT INTO team_members");
  });

  it("re-states the owner and privileges, and changes nothing else", () => {
    expect(code.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(code).toContain("SECURITY DEFINER");
    expect(code).toContain("SET search_path = public");
    expect(code).toContain("ALTER FUNCTION public.attach_user_to_invited_account(UUID, UUID) OWNER TO postgres;");
    expect(code).toContain("REVOKE ALL ON FUNCTION public.attach_user_to_invited_account(UUID, UUID) FROM PUBLIC, anon, authenticated;");
    expect(code).not.toMatch(/CREATE TABLE|ALTER TABLE|CREATE POLICY|DROP |CREATE TRIGGER|INSERT INTO (?!team_members)|GRANT /i);
  });

  it("has a verify script that accepts as a new person, refuses a workspace with a case, and ends in the deliberate rollback", () => {
    expect(verify).toContain("RAISE EXCEPTION 'ROLLBACK-OK:");
    for (const s of ["redeem_invitation", "compliance_system_type_is_fixed", "purge_account", "already contains data", "compliance_requests", "42501", "search_path"]) {
      expect(verify, s).toContain(s);
    }
  });
});
