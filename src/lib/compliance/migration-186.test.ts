import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readMigration } from "@/lib/testing/read-migration";

import { typeSupportsPublicForm } from "./public/service";
import { BANK_OWN, LETTER_186, TYPE_ROWS, WITHDRAWAL_FIELDS_184, CLOSURE_FIELDS_184 } from "./test-support";
import { typeFromRow } from "./service/rows";

// Guards on the TEXT of migration 186 (Compliance requests: "does this bank account belong to you?" on the closure and withdrawal types). The behaviour is
// proven against a database by supabase/ci/verify-186-compliance-bank-own-account.sql (run it rolled back against production with 183, 184, 185 and 186 in
// front when they are not applied yet; it also ran in PGlite for this change, with mutations of 186 each making it fail, see docs/compliance-requests.md).
// These checks stop a later edit from quietly undoing the design: an administrator's edits survive, nothing is callable by a browser role, the seed still
// seeds everything, and the SQL and the TypeScript agree on the definitions.

const sql = readMigration("186_compliance_bank_own_account.sql").replace(/\r\n/g, "\n");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-186-compliance-bank-own-account.sql"), "utf8").replace(/\r\n/g, "\n");
const guard = readFileSync(join(process.cwd(), "supabase", "ci", "verify-guard-catalog.sql"), "utf8").replace(/\r\n/g, "\n");
const fn = (name: string) => code.slice(code.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`), code.indexOf(`ALTER FUNCTION public.${name}(`));

describe("migration 186", () => {
  it("is idempotent and destroys nothing", () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(code).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|CREATE TABLE/);
    // it changes the definitions of the types and nothing about a case
    expect(code).not.toMatch(/UPDATE public\.compliance_requests\b/);
    expect(code).toContain("UPDATE public.compliance_request_types");
  });

  it("adds the question only when its key is absent, to the closure and withdrawal types, right before the bank name", () => {
    const f = fn("compliance_bank_own_fields");
    expect(f).toContain("t.key IN ('closure', 'withdrawal')");
    expect(f).toContain("IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.fields) f WHERE f ->> 'key' = 'bank_account_is_own')");
    expect(f).toContain("e.f ->> 'key' = 'bank_name'");
    expect(f).toContain("jsonb_insert(t.fields, ARRAY[v_at::text], v_own)");
    // at the end when there is no bank name
    expect(f).toContain("WHEN v_at IS NULL THEN t.fields || jsonb_build_array(v_own)");
    // a required, protected-by-nothing yes / no with four languages
    expect(f).toMatch(/'key', 'bank_account_is_own', 'type', 'yesno', 'required', true, 'sensitive', false/);
    expect(f.match(/public\.compliance_label\(/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("makes the letter conditional and required only while it has no condition, and rewords it only while the words are 183's", () => {
    const f = fn("compliance_bank_own_fields");
    expect(f).toContain("e.f ->> 'key' = 'authorization_letter' AND NOT (e.f ? 'showIf')");
    expect(f).toContain("AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.fields) f WHERE f ->> 'key' = 'authorization_letter' AND NOT (f ? 'showIf'))");
    expect(f).toContain("CASE WHEN e.f -> 'label' = v_old THEN jsonb_set(e.f, '{label}', v_new) ELSE e.f END");
    expect(f).toContain("jsonb_build_object('required', true, 'showIf', v_show)");
    expect(f).toContain("jsonb_build_object('field', 'bank_account_is_own', 'in', jsonb_build_array('false'))");
    // 183's words, exactly as 183 seeded them
    const m183 = readMigration("183_compliance_requests.sql").replace(/\r\n/g, "\n");
    for (const w of ["Authorization letter (needed when the bank account holder name differs)", "Surat kebenaran (diperlukan jika nama pemegang akaun bank berbeza)", "授权书（银行账户持有人姓名不同时需要）", "위임장(은행 계좌 예금주 이름이 다를 때 필요)"]) {
      expect(m183, w).toContain(w);
      expect(f, w).toContain(w);
    }
  });

  it("never touches the bank details, the other types or any case", () => {
    const f = fn("compliance_bank_own_fields");
    expect(f).not.toMatch(/'key' = 'bank_account_(number|holder)'|'bank_name' THEN|sensitive', true/);
    expect(f).not.toContain("phone_change");
    expect(f).not.toMatch(/compliance_requests\b/);
  });

  it("keeps the seed seeding the three types, 184's fields, 185's fields and the new question, and runs for the workspaces that exist", () => {
    const seed = fn("compliance_accounts_seed");
    for (const c of ["compliance_seed_types", "compliance_intake_fields", "compliance_account_change_fields", "compliance_bank_own_fields"]) expect(seed, c).toContain(`PERFORM public.${c}(NEW.id)`);
    expect(seed).toContain("EXCEPTION WHEN OTHERS THEN");
    expect(code).toMatch(/PERFORM public\.compliance_bank_own_fields\(a\.id\) FROM public\.accounts a/);
    // 185's seed is the one this replaces: it lists the same three calls
    const m185 = readMigration("185_compliance_chat_link.sql").replace(/\r\n/g, "\n");
    expect((m185.match(/PERFORM public\.compliance_\w+\(NEW\.id\)/g) ?? []).length).toBe(3);
  });

  it("makes nothing callable by a signed-in or signed-out user, and pins the search_path", () => {
    expect(code).not.toMatch(/GRANT EXECUTE[^;]*\b(authenticated|anon|PUBLIC)\b/);
    const functions = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(functions.sort()).toEqual(["compliance_accounts_seed", "compliance_bank_own_fields"]);
    for (const f of functions) expect(code, f).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
    for (const b of code.split("CREATE OR REPLACE FUNCTION public.").slice(1)) expect(b.slice(0, b.indexOf("AS $$")), b.slice(0, 40)).toMatch(/SET search_path = public/);
    expect(code).toContain("GRANT EXECUTE ON FUNCTION public.compliance_bank_own_fields(UUID) TO service_role");
    const authenticatedOk = guard.match(/authenticated_ok text\[\] := ARRAY\[([\s\S]*?)\];/)![1];
    for (const f of functions) expect(authenticatedOk).not.toContain(f);
  });

  it("agrees with the TypeScript definitions the tests and the forms use", () => {
    const f = fn("compliance_bank_own_fields");
    expect(BANK_OWN).toMatchObject({ key: "bank_account_is_own", type: "yesno", required: true, sensitive: false });
    expect(LETTER_186).toMatchObject({ key: "authorization_letter", type: "file", required: true, showIf: { field: "bank_account_is_own", in: ["false"] } });
    expect(f).toContain(`'key', '${BANK_OWN.key}', 'type', '${BANK_OWN.type}'`);
    // the English question is the one the public form words
    expect(f).toContain("Does this bank account belong to you, the Vircle account holder?");
    // the public forms need the key: a type without it is 'not available', with it the form works
    const closure = typeFromRow({ ...TYPE_ROWS[0], fields: CLOSURE_FIELDS_184 });
    const withdrawal = typeFromRow({ ...TYPE_ROWS[1], fields: WITHDRAWAL_FIELDS_184 });
    expect(typeSupportsPublicForm(closure, "closure")).toBe(true);
    expect(typeSupportsPublicForm(withdrawal, "withdrawal")).toBe(true);
    const lacking = (t: typeof closure) => ({ ...t, fields: t.fields.filter((x) => x.key !== "bank_account_is_own") });
    expect(typeSupportsPublicForm(lacking(closure), "closure")).toBe(false);
    expect(typeSupportsPublicForm(lacking(withdrawal), "withdrawal")).toBe(false);
  });

  it("has a verify script that ends in the deliberate rollback and checks the things above", () => {
    expect(verify).toContain("RAISE EXCEPTION 'ROLLBACK-OK:");
    for (const s of [
      "compliance_bank_own_fields", "bank_account_is_own", "authorization_letter", "yesno", "showIf", "compliance_accounts_seed", "has_function_privilege",
      "Admin words for the question", "Our own letter words", "right before the bank name", "an existing case is not rewritten", "INSERT INTO compliance_requests",
    ]) {
      expect(verify, s).toContain(s);
    }
    expect(verify).not.toMatch(/DELETE FROM contacts|DELETE FROM conversations/);
    expect(verify).toMatch(/INSERT INTO auth\.users/);
  });
});
