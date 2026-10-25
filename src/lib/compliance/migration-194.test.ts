import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateFieldDefs } from "@/lib/compliance/fields";
import { readMigration } from "@/lib/testing/read-migration";

// Guards on the TEXT of migration 194 (the Transaction fraud review type). The behaviour is proven against a database by
// supabase/ci/verify-194-compliance-fraud-review.sql (run it rolled back against production, with 194's text in front until it is applied).

const sql = readMigration("194_compliance_fraud_review.sql").replace(/\r\n/g, "\n");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-194-compliance-fraud-review.sql"), "utf8").replace(/\r\n/g, "\n");

// The field definitions, read back out of the SQL: key, type, required, sensitive (each appears on one line of the migration).
const FIELD_RE = /jsonb_build_object\('key', '([a-z_]+)', 'type', '([a-z]+)', 'required', (true|false), 'sensitive', (true|false)/g;
const defs = [...code.matchAll(FIELD_RE)].map((m) => ({ key: m[1]!, type: m[2]!, required: m[3] === "true", sensitive: m[4] === "true" }));

describe("migration 194", () => {
  it("is idempotent, never overwrites an existing type, and adds an ordinary (editable) type", () => {
    expect(code).toContain("CREATE OR REPLACE FUNCTION public.compliance_fraud_review_type");
    expect(code).toContain("ON CONFLICT (account_id, key) DO NOTHING");
    // ... 7, 30 days; identity check on; dues check off; pause off; NOT a system type; position 4
    expect(code).toMatch(/7, 30, TRUE, FALSE, FALSE, FALSE, 4\)/);
    expect(code).toContain("'fraud_review', 'Transaction fraud review'");
  });

  it("adds no table, policy, grant to a browser role or capability, and keeps the function service-role only", () => {
    expect(code).not.toMatch(/CREATE TABLE|CREATE POLICY|capability_catalogue/);
    expect(code).toContain("REVOKE ALL ON FUNCTION public.compliance_fraud_review_type(UUID) FROM PUBLIC, anon, authenticated;");
    expect(code).toContain("GRANT EXECUTE ON FUNCTION public.compliance_fraud_review_type(UUID) TO service_role;");
    expect(code).toContain("SET search_path = public");
  });

  it("seeds the workspaces that exist and every new one, without dropping an earlier part of the seed", () => {
    expect(code).toContain("PERFORM public.compliance_fraud_review_type(a.id) FROM public.accounts a;");
    for (const fn of ["compliance_seed_types", "compliance_intake_fields", "compliance_account_change_fields", "compliance_bank_own_fields", "compliance_fraud_review_type"]) {
      expect(code).toContain(`PERFORM public.${fn}(NEW.id);`);
    }
  });

  it("defines the fifteen fields in order: the report, the screenshots, then the investigation", () => {
    expect(defs.map((d) => d.key)).toEqual([
      "fraud_kind",
      "transaction_ref",
      "transaction_date",
      "amount",
      "customer_wallet_id",
      "recipient_name",
      "recipient_account",
      "description",
      "police_report",
      "screenshots",
      "investigation_findings",
      "investigation_outcome",
      "amount_recovered",
      "action_taken",
      "investigation_files",
    ]);
  });

  it("asks five things as required (the investigation is filled in later), and protects only the recipient's account", () => {
    expect(defs.filter((d) => d.required).map((d) => d.key)).toEqual(["fraud_kind", "transaction_ref", "transaction_date", "amount", "description"]);
    expect(defs.filter((d) => d.sensitive).map((d) => d.key)).toEqual(["recipient_account"]);
    expect(defs.filter((d) => d.type === "file").map((d) => d.key)).toEqual(["screenshots", "investigation_files"]);
    expect(defs.filter((d) => d.type === "choice").map((d) => d.key)).toEqual(["fraud_kind", "investigation_outcome"]);
  });

  it("passes the same validation an administrator's own type does (keys, kinds, what may be sensitive, options)", () => {
    const withOptions = defs.map((d) => ({
      ...d,
      label: { en: d.key },
      ...(d.type === "choice" ? { options: [{ value: "a", label: { en: "A" } }] } : {}),
    }));
    const result = validateFieldDefs(withOptions);
    expect(result.ok).toBe(true);
    expect(new Set(defs.map((d) => d.key)).size).toBe(defs.length);
  });

  it("has the five steps of the checklist and gives every label four languages", () => {
    for (const step of ["preserve_evidence", "restrict_account", "recall_funds", "report_authorities", "confirm_customer"]) {
      expect(code).toContain(`jsonb_build_object('key', '${step}', 'label', public.compliance_label(`);
    }
    // every compliance_label call carries four non-empty strings (en, ms, zh, ko)
    const calls = [...code.matchAll(/public\.compliance_label\(((?:'(?:[^']|'')*'\s*,?\s*)+)\)/g)];
    expect(calls.length).toBeGreaterThan(25);
    for (const c of calls) expect([...c[1]!.matchAll(/'((?:[^']|'')*)'/g)].filter((m) => m[1]!.trim() !== "")).toHaveLength(4);
  });

  it("has a verify script that ends rolled back and covers the seed, the case and the rules above", () => {
    expect(verify).toContain("ROLLBACK-OK");
    for (const part of ["fraud_review", "recipient_account", "screenshots", "investigation_files", "'preserve_evidence'", "compliance_fraud_review_type"]) expect(verify).toContain(part);
  });
});
