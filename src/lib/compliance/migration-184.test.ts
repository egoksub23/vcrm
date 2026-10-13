import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CAPABILITIES, DEFAULT_CAPABILITIES, getCapability } from "@/lib/auth/capabilities";
import { readMigration } from "@/lib/testing/read-migration";

import { DB_CODE_LIST } from "./errors";
import { TRANSITIONS } from "./transitions";
import { EVENT_KINDS, NOTICE_KINDS, REJECTION_CATEGORIES } from "./types";

// Guards on the TEXT of migration 184 (Compliance requests, Part B). The behaviour is proven against a database by
// supabase/ci/verify-184-compliance-intake.sql (run it rolled back against production with 183 and 184 in front when they are not applied yet; it also
// ran in PGlite for this change, see docs/compliance-requests.md). These checks stop a later edit from quietly undoing the design: nothing callable by a
// signed-in user, no browser privilege on the new tables, the raiser's read gone, the unique index, 183's transition table kept in the replaced function,
// and the TypeScript constants agreeing with the SQL.

const sql = readMigration("184_compliance_intake.sql").replace(/\r\n/g, "\n");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const m183 = readMigration("183_compliance_requests.sql").replace(/\r\n/g, "\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-184-compliance-intake.sql"), "utf8").replace(/\r\n/g, "\n");
const guard = readFileSync(join(process.cwd(), "supabase", "ci", "verify-guard-catalog.sql"), "utf8").replace(/\r\n/g, "\n");

describe("migration 184", () => {
  it("is idempotent", () => {
    expect(code.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(4);
    expect(code).toMatch(/ON CONFLICT \(capability\) DO UPDATE/);
    expect(code).toMatch(/ON CONFLICT \(role, capability\) DO NOTHING/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS customer_locale/);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS email_verified_at/);
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS compliance_requests_form_open_email/);
    expect(code).toMatch(/DROP CONSTRAINT IF EXISTS compliance_request_events_kind_check/);
    expect(code).toMatch(/DROP CONSTRAINT IF EXISTS compliance_requests_customer_locale_check/);
    expect(code.match(/DROP POLICY IF EXISTS/g)).toHaveLength(4);
    for (const t of ["compliance_notices_no_delete", "compliance_exports_no_change", "compliance_exports_no_truncate"]) expect(code, t).toContain(`DROP TRIGGER IF EXISTS ${t} ON`);
  });

  it("seeds compliance.raise exactly as the TypeScript catalogue has it (app tier, grantable to agent, Owner and Admin by default, NOT tied to menu.compliance)", () => {
    expect(getCapability("compliance.raise")).toMatchObject({ enforcedBy: "app", minGrantRole: "agent", group: "compliance" });
    expect(code).toMatch(/\('compliance\.raise', 'agent', 'app'\)/);
    expect(code).toContain("('owner', 'compliance.raise'), ('admin', 'compliance.raise')");
    expect(DEFAULT_CAPABILITIES.agent.has("compliance.raise")).toBe(false);
    expect(DEFAULT_CAPABILITIES.viewer.has("compliance.raise")).toBe(false);
    expect(DEFAULT_CAPABILITIES.owner.has("compliance.raise")).toBe(true);
    expect(DEFAULT_CAPABILITIES.admin.has("compliance.raise")).toBe(true);
    // the whole compliance family: Part A's six and this one
    expect(CAPABILITIES.map((c) => c.key).filter((k) => k.startsWith("compliance.") || k === "menu.compliance")).toHaveLength(7);
  });

  it("agrees with the TypeScript constants: the event kinds (with 'notice'), the rejection categories, the notice kinds", () => {
    const list = (re: RegExp) => [...(code.match(re)?.[1] ?? "").matchAll(/'(\w+)'/g)].map((m) => m[1]);
    // (185 added form_link and form_submitted after this list)
    expect(list(/CHECK \(kind IN \(([^)]*)\)\);/).sort()).toEqual(EVENT_KINDS.filter((k) => k !== "form_link" && k !== "form_submitted").sort());
    expect(list(/IF v_cat IS NOT NULL AND NOT \(v_cat IN \(([^)]*)\)\)/)).toEqual([...REJECTION_CATEGORIES]);
    expect(list(/kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)/).sort()).toEqual([...NOTICE_KINDS].sort());
    expect(code).toContain("ARRAY['compliance_signoff']");
  });

  it("keeps 183's transition table, its capability checks and the maker-checker rule in the function it replaces", () => {
    const fn = (s: string) => s.slice(s.indexOf("CREATE OR REPLACE FUNCTION public.compliance_transition("), s.indexOf("ALTER FUNCTION public.compliance_transition("));
    const parse = (s: string) => {
      const block = s.slice(s.indexOf("v_ok := CASE r.status"), s.indexOf("ELSE FALSE", s.indexOf("v_ok := CASE r.status")));
      const out: Record<string, string[]> = {};
      for (const m of block.matchAll(/WHEN '(\w+)'\s+THEN p_to IN \(([^)]*)\)/g)) out[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort();
      return out;
    };
    const mine = Object.fromEntries(Object.entries(TRANSITIONS).filter(([, to]) => to.length > 0).map(([from, to]) => [from, [...to].sort()]));
    expect(parse(fn(code))).toEqual(mine);
    expect(parse(fn(code))).toEqual(parse(fn(m183)));
    // everything 183's function checked is still checked
    for (const must of ["compliance_maker_checker", "compliance_dues_outstanding", "compliance_checklist_incomplete", "compliance_identity_not_passed", "compliance_recommendation_required", "compliance_note_required", "compliance_user_can(r.account_id, p_actor, 'compliance.approve')", "compliance_user_can(r.account_id, p_actor, 'compliance.execute')", "FOR UPDATE", "vircle.compliance_fn"]) {
      expect(fn(code), must).toContain(must);
    }
    // the one addition: a rejection keeps its category and the customer's words, validated when given, never required here
    expect(fn(code)).toContain("'reason_category', CASE WHEN p_to = 'rejected' THEN v_cat END");
    expect(fn(code)).toContain("'customer_reason', CASE WHEN p_to = 'rejected' THEN v_cust END");
    expect(fn(code)).toContain("compliance_bad_category");
    expect(fn(code)).not.toMatch(/IF v_cat IS NULL/);
    // and it is still a function for the service role only
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.compliance_transition\(UUID, TEXT, UUID, TEXT, JSONB\) FROM PUBLIC, anon, authenticated/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.compliance_transition\(UUID, TEXT, UUID, TEXT, JSONB\) TO service_role/);
    // the database's new words are ones the routes map
    expect(DB_CODE_LIST).toContain("compliance_bad_category");
  });

  it("takes the raiser's read of the case away: the policies on the case, its events, checklist and files follow menu.compliance only", () => {
    const policies = code.match(/CREATE POLICY[\s\S]*?;\n/g) ?? [];
    expect(policies).toHaveLength(4);
    for (const p of policies) {
      expect(p).toContain("menu.compliance");
      expect(p).not.toContain("created_by");
    }
    expect(m183).toContain("OR created_by = auth.uid()");
  });

  it("holds one OPEN request per type per verified email from the form with a partial unique index, case-insensitively", () => {
    const idx = code.slice(code.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS compliance_requests_form_open_email"), code.indexOf(";", code.indexOf("compliance_requests_form_open_email")));
    expect(idx).toContain("(account_id, type_key, lower(customer_email))");
    expect(idx).toContain("source = 'form'");
    for (const open of ["received", "identity_check", "officer_review", "awaiting_signoff", "approved", "executing"]) expect(idx, open).toContain(`'${open}'`);
    for (const done of ["rejected", "completed", "closed"]) expect(idx, done).not.toContain(`'${done}'`);
  });

  it("scopes the new tables to their workspace with composite foreign keys, and keeps them from the browser entirely", () => {
    expect(code).toMatch(/CONSTRAINT compliance_public_forms_type_fk FOREIGN KEY \(account_id, type_key\)\s+REFERENCES public\.compliance_request_types \(account_id, key\)/);
    expect(code).toMatch(/CONSTRAINT compliance_email_codes_form_fk FOREIGN KEY \(form_id, account_id\)\s+REFERENCES public\.compliance_public_forms \(id, account_id\)/);
    expect(code).toMatch(/CONSTRAINT compliance_notices_request_fk FOREIGN KEY \(request_id, account_id\)\s+REFERENCES public\.compliance_requests \(id, account_id\)/);
    expect(code).toMatch(/CONSTRAINT compliance_notices_once UNIQUE \(request_id, kind, key\)/);
    expect(code).toMatch(/CONSTRAINT compliance_public_forms_slug UNIQUE \(slug\)/);
    expect(code).toMatch(/CONSTRAINT compliance_public_forms_type UNIQUE \(account_id, type_key\)/);
    for (const t of ["compliance_public_forms", "compliance_email_codes", "compliance_notices", "compliance_exports"]) expect(code, t).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
    expect(code).toMatch(/REVOKE ALL ON public\.compliance_public_forms, public\.compliance_email_codes, public\.compliance_notices, public\.compliance_exports FROM PUBLIC, anon, authenticated/);
    // nothing is granted back, and no policy is added for them: the server is the only reader
    expect(code).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*\bON\b[^;]*compliance_(public_forms|email_codes|notices|exports)/);
    expect(code).not.toMatch(/CREATE POLICY \w+ ON public\.compliance_(public_forms|email_codes|notices|exports)/);
  });

  it("allows a public form only for the two customer types, with an unguessable slug, and checks the amount and the bank list", () => {
    expect(code).toMatch(/type_key\s+TEXT NOT NULL CHECK \(type_key IN \('closure', 'withdrawal'\)\)/);
    expect(code).toContain("slug ~ '^[a-z0-9][a-z0-9-]{4,38}[a-z0-9]$'");
    expect(code).toContain("max_amount > 0 AND max_amount <= 100000000");
    // the bank list check cannot trip over a scalar (a CASE, not two ANDed tests the planner may reorder)
    expect(code).toMatch(/CASE WHEN jsonb_typeof\(banks\) = 'array' THEN jsonb_array_length\(banks\) BETWEEN 1 AND 80 ELSE FALSE END/);
  });

  it("stores only hashes of the code and the address, and caps the tries", () => {
    const table = code.slice(code.indexOf("CREATE TABLE IF NOT EXISTS public.compliance_email_codes"), code.indexOf("CREATE INDEX IF NOT EXISTS compliance_email_codes_lookup_idx"));
    expect(table).toContain("email_hash  TEXT NOT NULL CHECK (length(email_hash) BETWEEN 16 AND 128)");
    expect(table).toContain("code_hash   TEXT NOT NULL CHECK (length(code_hash) BETWEEN 16 AND 128)");
    expect(table).toContain("attempts    SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20)");
    expect(table).not.toMatch(/\bemail\s+TEXT|\bcode\s+TEXT|phone/i);
  });

  it("makes the exports log append-only for every role, the purge of the workspace excepted", () => {
    const fn = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION public.compliance_exports_no_change"), code.indexOf("ALTER FUNCTION public.compliance_exports_no_change"));
    expect(fn).toContain("vircle.purge_account");
    expect(fn).toContain("current_user NOT IN ('anon', 'authenticated', 'service_role')");
    expect(fn).not.toMatch(/SECURITY DEFINER/);
    expect(code).toMatch(/BEFORE UPDATE OR DELETE ON public\.compliance_exports/);
    expect(code).toMatch(/BEFORE TRUNCATE ON public\.compliance_exports/);
    // the notices follow the case's retention through 183's trigger function
    expect(code).toMatch(/BEFORE DELETE ON public\.compliance_notices\s+FOR EACH ROW EXECUTE FUNCTION public\.compliance_children_no_delete\(\)/);
  });

  it("adds the intake fields without overwriting an administrator's edit, and gives a new workspace the same", () => {
    const fn = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION public.compliance_intake_fields"), code.indexOf("ALTER FUNCTION public.compliance_intake_fields"));
    expect(fn.match(/NOT EXISTS \(SELECT 1 FROM jsonb_array_elements\(t\.fields\) f WHERE f ->> 'key' = '(declaration|reason_kind|proof)'\)/g)).toHaveLength(3);
    expect(fn).toContain("'required', false");
    expect(fn).not.toMatch(/'sensitive', true/);
    // the labels carry all four languages (compliance_label makes the object)
    expect(fn.match(/public\.compliance_label\(/g)!.length).toBeGreaterThanOrEqual(5);
    const seed = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION public.compliance_accounts_seed"), code.indexOf("ALTER FUNCTION public.compliance_accounts_seed"));
    expect(seed).toContain("PERFORM public.compliance_seed_types(NEW.id)");
    expect(seed).toContain("PERFORM public.compliance_intake_fields(NEW.id)");
    expect(seed).toContain("EXCEPTION WHEN OTHERS THEN");
    expect(code).toMatch(/PERFORM public\.compliance_intake_fields\(a\.id\) FROM public\.accounts a/);
  });

  it("makes no function callable by a signed-in or signed-out user, and pins every search_path", () => {
    expect(code).not.toMatch(/GRANT EXECUTE[^;]*\b(authenticated|anon|PUBLIC)\b/);
    const functions = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(functions.sort()).toEqual(["compliance_accounts_seed", "compliance_exports_no_change", "compliance_intake_fields", "compliance_transition"]);
    for (const f of functions) expect(code, f).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
    for (const b of code.split("CREATE OR REPLACE FUNCTION public.").slice(1)) {
      const head = b.slice(0, b.indexOf("AS $$"));
      expect(head, b.slice(0, 40)).toMatch(/SET search_path = public/);
    }
    // so the reviewed lists in the catalogue guard need no entry
    const authenticatedOk = guard.match(/authenticated_ok text\[\] := ARRAY\[([\s\S]*?)\];/)![1];
    for (const f of functions) expect(authenticatedOk).not.toContain(f);
  });

  it("has a verify script that ends in the deliberate rollback and checks the things above", () => {
    expect(verify).toContain("RAISE EXCEPTION 'ROLLBACK-OK:");
    for (const s of [
      "compliance.raise", "compliance_signoff", "'notice'", "customer_locale", "compliance_requests_form_open_email", "created_by", "compliance_public_forms", "compliance_email_codes",
      "compliance_notices", "compliance_exports", "compliance_intake_fields", "reason_category", "customer_reason", "maker_checker", "set_role_capabilities", "has_function_privilege",
    ]) {
      expect(verify, s).toContain(s);
    }
    // against the real schema: the NOT NULL columns of contacts, tickets and conversations
    expect(verify).toMatch(/INSERT INTO contacts \(id, account_id, phone\)/);
    expect(verify).toMatch(/INSERT INTO tickets \(id, account_id, ticket_number, contact_id, subject\)/);
    expect(verify).toMatch(/INSERT INTO conversations \(id, user_id, account_id, contact_id\)/);
    expect(verify).not.toMatch(/DELETE FROM contacts/);
  });
});
