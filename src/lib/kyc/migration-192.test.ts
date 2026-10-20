import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { KYC_ACTIONS, KYC_DECISIONS, KYC_OUTCOMES } from "@/lib/kyc/types";
import { readMigration } from "@/lib/testing/read-migration";

// Guards on the TEXT of migration 192 (KYC: the access log's 'amend' action). The behaviour is proven against a database by
// supabase/ci/verify-192-kyc-amend.sql (run it rolled back against production, with 192's text in front until it is applied).

const sql = readMigration("192_kyc_amend.sql").replace(/\r\n/g, "\n");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-192-kyc-amend.sql"), "utf8").replace(/\r\n/g, "\n");

describe("migration 192", () => {
  it("is idempotent", () => {
    expect(code.match(/DROP CONSTRAINT IF EXISTS/g)).toHaveLength(3);
    expect(code.match(/ADD CONSTRAINT/g)).toHaveLength(3);
  });

  it("allows exactly the actions the code writes, now including 'amend', and still only the same outcomes and decisions", () => {
    const m = /kyc_access_log_action_check\s+CHECK \(action IN \(([^)]*)\)/.exec(code);
    expect(m).not.toBeNull();
    expect([...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toEqual([...KYC_ACTIONS]);
    expect(KYC_ACTIONS).toContain("amend");
    // 192 does not touch the outcome or decision lists
    expect(code).not.toContain("kyc_access_log_outcome_check");
    expect(code).not.toContain("kyc_access_log_decision_check");
    expect([...KYC_OUTCOMES]).toEqual(["ok", "not_found", "forbidden", "error", "attempt"]);
    expect([...KYC_DECISIONS]).toEqual(["approve", "reject"]);
  });

  it("makes a decision or an amendment carry its decision and no other row carry one, and an amendment can only approve", () => {
    expect(code).toMatch(/CHECK \(\(action IN \('decision', 'amend'\)\) = \(decision IS NOT NULL\)\)/);
    expect(code).toMatch(/CHECK \(action <> 'amend' OR decision = 'approve'\)/);
  });

  it("changes nothing else: no column, policy, grant, function or trigger, and the log stays append-only", () => {
    expect(code).not.toMatch(/CREATE POLICY|DROP POLICY|GRANT |REVOKE |CREATE (OR REPLACE )?FUNCTION|SECURITY\s+DEFINER|DROP TRIGGER|CREATE TRIGGER|DISABLE TRIGGER|ADD COLUMN|DROP COLUMN|INSERT INTO|UPDATE |DELETE FROM/i);
  });

  it("has a verify script that ends in the deliberate rollback and checks the amendment, the refusals and that the log is still closed", () => {
    expect(verify).toContain("RAISE EXCEPTION 'ROLLBACK-OK:");
    for (const s of ["'amend'", "'reject')", "append-only", "42501", "23514"]) expect(verify, s).toContain(s);
  });
});
