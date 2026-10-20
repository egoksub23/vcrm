import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_CAPABILITIES, getCapability } from "@/lib/auth/capabilities";
import { KYC_ACTIONS, KYC_DECISIONS, KYC_OUTCOMES } from "@/lib/kyc/types";
import { readMigration } from "@/lib/testing/read-migration";

// Guards on the TEXT of migration 188 (KYC decisions). The behaviour is proven against a database by supabase/ci/verify-188-kyc-decisions.sql (run it
// rolled back against production, with 188's text in front until it is applied). These checks stop a later edit from quietly undoing the design: a
// separate permission for deciding, a log that still takes only well-formed rows, and no new function a signed-in user can call.

const sql = readMigration("188_kyc_decisions.sql").replace(/\r\n/g, "\n");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-188-kyc-decisions.sql"), "utf8").replace(/\r\n/g, "\n");

describe("migration 188", () => {
  it("is idempotent", () => {
    expect(code).toMatch(/ON CONFLICT \(capability\) DO UPDATE/);
    expect(code).toMatch(/ON CONFLICT \(role, capability\) DO NOTHING/);
    expect(code.match(/DROP CONSTRAINT IF EXISTS/g)).toHaveLength(4);
    expect(code.match(/ADD CONSTRAINT/g)).toHaveLength(4);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS decision TEXT/);
  });

  it("seeds kyc.decide exactly as the TypeScript catalogue has it (app tier, grantable to agent, Owner and Admin by default, never a viewer)", () => {
    expect(getCapability("kyc.decide")).toMatchObject({ enforcedBy: "app", minGrantRole: "agent", group: "kyc" });
    expect(code).toMatch(/\('kyc\.decide',\s+'agent',\s+'app'\)/);
    expect(code).toContain("('owner', 'kyc.decide')");
    expect(code).toContain("('admin', 'kyc.decide')");
    expect(code).not.toContain("('agent', 'kyc.decide')");
    expect(code).not.toContain("('viewer', 'kyc.decide')");
    expect(DEFAULT_CAPABILITIES.agent.has("kyc.decide")).toBe(false);
    expect(DEFAULT_CAPABILITIES.viewer.has("kyc.decide")).toBe(false);
    expect(DEFAULT_CAPABILITIES.owner.has("kyc.decide")).toBe(true);
    expect(DEFAULT_CAPABILITIES.admin.has("kyc.decide")).toBe(true);
  });

  it("allows exactly the actions, outcomes and decisions the code writes", () => {
    const list = (constraint: string) => {
      const m = new RegExp(`${constraint}\\s+CHECK \\((?:decision IS NULL OR )?\\w+ IN \\(([^)]*)\\)`).exec(code);
      return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null;
    };
    // 188's list; 'amend' came with migration 192 (its own test checks the whole list)
    expect(list("kyc_access_log_action_check")).toEqual(KYC_ACTIONS.filter((a) => a !== "amend"));
    expect(list("kyc_access_log_outcome_check")).toEqual([...KYC_OUTCOMES]);
    expect(list("kyc_access_log_decision_check")).toEqual([...KYC_DECISIONS]);
  });

  it("makes a 'decision' row carry its decision and no other row carry one", () => {
    expect(code).toMatch(/CHECK \(\(action = 'decision'\) = \(decision IS NOT NULL\)\)/);
  });

  it("changes nothing about who may read or write the log, and adds no function", () => {
    expect(code).not.toMatch(/CREATE POLICY|DROP POLICY|GRANT |REVOKE |CREATE (OR REPLACE )?FUNCTION|SECURITY\s+DEFINER|DROP TRIGGER|CREATE TRIGGER|DISABLE TRIGGER/i);
    // no column that could hold a note, a value or an upstream answer
    expect([...code.matchAll(/ADD COLUMN[^;]*/gi)].map((m) => m[0])).toEqual(["ADD COLUMN IF NOT EXISTS decision TEXT"]);
  });

  it("has a verify script that ends in the deliberate rollback and checks the things above", () => {
    expect(verify).toContain("RAISE EXCEPTION 'ROLLBACK-OK:");
    for (const s of ["kyc.decide", "set_role_capabilities", "'decision'", "'attempt'", "append-only", "viewer"]) expect(verify, s).toContain(s);
  });
});
