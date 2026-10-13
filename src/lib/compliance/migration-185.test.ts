import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readMigration } from "@/lib/testing/read-migration";

import { DB_CODE_LIST } from "./errors";
import { LINK_STATES, LINK_TTL_DAYS, LINK_TTL_MAX_DAYS, LINK_TTL_MIN_DAYS } from "./chat-link/link-state";
import { NOT_SENT_REASONS } from "./chat-link/types";
import { ACCOUNT_CHANGE_FIELDS } from "./chat-link/test-support";
import { ERROR_CODES, EVENT_KINDS } from "./types";

// Guards on the TEXT of migration 185 (Compliance requests linked to the chat: the personal closure form link, the link card message, Account change). The
// behaviour is proven against a database by supabase/ci/verify-185-compliance-chat-link.sql (run it rolled back against production with 183, 184 and 185 in
// front when they are not applied yet; it also ran in PGlite for this change, with four mutations of 185 each making it fail, see docs/compliance-requests.md).
// These checks stop a later edit from quietly undoing the design.

const sql = readMigration("185_compliance_chat_link.sql").replace(/\r\n/g, "\n");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-185-compliance-chat-link.sql"), "utf8").replace(/\r\n/g, "\n");
const guard = readFileSync(join(process.cwd(), "supabase", "ci", "verify-guard-catalog.sql"), "utf8").replace(/\r\n/g, "\n");
const fn = (name: string) => code.slice(code.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`), code.indexOf(`ALTER FUNCTION public.${name}(`));

describe("migration 185", () => {
  it("is idempotent", () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.compliance_form_links/);
    expect(code).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS compliance_form_links_one_active/);
    expect(code).toMatch(/DROP CONSTRAINT IF EXISTS compliance_request_events_kind_check/);
    expect(code).toMatch(/DROP POLICY IF EXISTS compliance_form_links_select/);
    for (const t of ["compliance_form_links_guard", "compliance_form_links_no_delete", "compliance_form_links_no_truncate"]) expect(code, t).toContain(`DROP TRIGGER IF EXISTS ${t} ON`);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(code).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE TABLE|DELETE FROM/);
  });

  it("agrees with the TypeScript constants: the event kinds, the link states' reasons, the not-sent reasons, the days", () => {
    const list = (re: RegExp, text = code) => [...(text.match(re)?.[1] ?? "").matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(list(/CHECK \(kind IN \(([^)]*)\)\);/).sort()).toEqual([...EVENT_KINDS].sort());
    expect(EVENT_KINDS).toEqual(expect.arrayContaining(["form_link", "form_submitted"]));
    expect(list(/p_reason IN \(([^)]*)\)/, fn("compliance_form_link_sent")).sort()).toEqual([...NOT_SENT_REASONS].sort());
    expect(list(/revoked_reason IS NULL OR revoked_reason IN \(([^)]*)\)/)).toEqual(["replaced", "revoked"]);
    expect(LINK_STATES).toEqual(["created", "sent", "opened", "submitted", "expired", "revoked", "replaced"]);
    expect(fn("compliance_mint_form_link")).toContain(`LEAST(${LINK_TTL_MAX_DAYS}, GREATEST(${LINK_TTL_MIN_DAYS}, COALESCE(p_ttl_days, ${LINK_TTL_DAYS})))`);
    expect(code).toContain("expires_at <= created_at + interval '31 days'");
    expect(code).toContain("ARRAY['compliance_form']");
    expect(code).toContain("ARRAY['link_card']");
  });

  it("maps every word the new functions can raise to a code the routes know", () => {
    const raised = [...new Set([...code.matchAll(/RAISE EXCEPTION '(compliance_[a-z_]+)/g)].map((m) => m[1]))];
    for (const r of raised) expect(DB_CODE_LIST.some((n) => n === r || r.startsWith(n)), r).toBe(true);
    expect(raised).toEqual(expect.arrayContaining(["compliance_form_link_invalid", "compliance_form_link_not_allowed", "compliance_form_link_submitted", "compliance_form_link_not_found"]));
    for (const c of ["form_link_not_allowed", "form_link_submitted"]) expect(ERROR_CODES).toContain(c);
  });

  it("keeps only a keyed hash of the token, and nothing a token could be rebuilt from", () => {
    const table = code.slice(code.indexOf("CREATE TABLE IF NOT EXISTS public.compliance_form_links"), code.indexOf("CREATE INDEX IF NOT EXISTS compliance_form_links_request_idx"));
    expect(table).toContain("token_hash      TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$')");
    expect(table).toContain("CONSTRAINT compliance_form_links_token UNIQUE (token_hash)");
    expect(table).not.toMatch(/\btoken\s+TEXT|\burl\b|\baddress\b|secret/i);
    // the browser may read the state of a link, never the hash
    const grant = code.slice(code.indexOf("GRANT SELECT (id, account_id, request_id"), code.indexOf("ON public.compliance_form_links TO authenticated"));
    expect(grant).not.toContain("token_hash");
    expect(code).toMatch(/REVOKE ALL ON public\.compliance_form_links FROM PUBLIC, anon, authenticated/);
    expect(code).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*compliance_form_links/);
  });

  it("scopes a link to its case's workspace with a composite foreign key, and lets a menu.compliance holder read it and nobody write it", () => {
    expect(code).toMatch(/CONSTRAINT compliance_form_links_request_fk FOREIGN KEY \(request_id, account_id\)\s+REFERENCES public\.compliance_requests \(id, account_id\) ON DELETE CASCADE/);
    expect(code).toMatch(/ALTER TABLE public\.compliance_form_links ENABLE ROW LEVEL SECURITY/);
    const policies = code.match(/CREATE POLICY[\s\S]*?;\n/g) ?? [];
    expect(policies).toHaveLength(1);
    expect(policies[0]).toContain("FOR SELECT TO authenticated");
    expect(policies[0]).toContain("has_capability(account_id, 'menu.compliance')");
    expect(policies[0]).not.toMatch(/created_by|auth\.uid/);
  });

  it("allows one ACTIVE link per case, by a partial unique index", () => {
    const idx = code.slice(code.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS compliance_form_links_one_active"), code.indexOf(";", code.indexOf("compliance_form_links_one_active")));
    expect(idx).toContain("(request_id)");
    expect(idx).toContain("revoked_at IS NULL AND submitted_at IS NULL");
  });

  it("lets only the functions write the table, never edit what is fixed, and follow the case's retention", () => {
    const guardFn = fn("compliance_form_links_guard");
    expect(guardFn).toContain("vircle.compliance_fn");
    expect(guardFn).toContain("compliance_form_link_change_refused");
    for (const col of ["token_hash", "request_id", "account_id", "created_by", "expires_at", "created_at"]) expect(guardFn, col).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
    expect(guardFn).toContain("IF OLD.submitted_at IS NOT NULL");
    expect(guardFn).not.toMatch(/SECURITY DEFINER/);
    expect(code).toMatch(/BEFORE INSERT OR UPDATE ON public\.compliance_form_links/);
    expect(code).toMatch(/BEFORE DELETE ON public\.compliance_form_links\s+FOR EACH ROW EXECUTE FUNCTION public\.compliance_children_no_delete\(\)/);
    expect(code).toMatch(/BEFORE TRUNCATE ON public\.compliance_form_links/);
  });

  it("claims and applies a submission in ONE function, under row locks, refusing a used, withdrawn, replaced or expired link and a case past review", () => {
    const apply = fn("compliance_apply_form_link");
    expect(apply).toContain("FROM public.compliance_form_links WHERE id = p_link FOR UPDATE");
    expect(apply).toContain("FROM public.compliance_requests WHERE id = l.request_id AND account_id = l.account_id FOR UPDATE");
    expect(apply).toContain("l.revoked_at IS NOT NULL OR l.submitted_at IS NOT NULL OR l.expires_at <= now()");
    expect(apply).toContain("r.status NOT IN ('received', 'identity_check', 'officer_review')");
    expect(apply).toContain("UPDATE public.compliance_form_links SET submitted_at = now()");
    expect(apply).toContain("'form_submitted'");
    // the identity check is not touched, nor the status
    expect(apply).not.toMatch(/identity_check\s*=/);
    expect(apply).not.toMatch(/\bstatus\s*=/);
    // the typed email is validated; the phone only fills a gap
    expect(apply).toContain("COALESCE(customer_phone, NULLIF(btrim(COALESCE(p_phone, '')), ''))");
    // no answers in the trail
    expect(apply.slice(apply.indexOf("'form_submitted'"), apply.indexOf("RETURN"))).not.toMatch(/p_name|p_email|p_data/);
  });

  it("revokes the previous link in the same transaction as it mints, and checks who may, for the named person", () => {
    const mint = fn("compliance_mint_form_link");
    expect(mint).toContain("FOR UPDATE");
    expect(mint).toContain("revoked_reason = 'replaced'");
    for (const cap of ["compliance.raise", "compliance.review", "compliance.approve"]) expect(mint, cap).toContain(`compliance_user_can(r.account_id, p_actor, '${cap}')`);
    expect(mint).toContain("r.type_key <> 'closure'");
    expect(mint).toContain("compliance_form_link_submitted");
    expect(mint).toContain("compliance_link_other_workspace: conversation");
    for (const name of ["compliance_form_link_sent", "compliance_revoke_form_link"]) for (const cap of ["compliance.raise", "compliance.review", "compliance.approve"]) expect(fn(name), `${name} ${cap}`).toContain(`'${cap}'`);
  });

  it("writes the trail without a token, an address or an answer", () => {
    for (const name of ["compliance_mint_form_link", "compliance_form_link_sent", "compliance_revoke_form_link", "compliance_form_link_opened", "compliance_apply_form_link"]) {
      const body = fn(name);
      for (const m of body.matchAll(/compliance_event\([^;]*;/g)) expect(m[0], `${name}: ${m[0]}`).not.toMatch(/p_token_hash|token|url|p_email|p_name|p_data|p_phone/);
    }
  });

  it("makes no function callable by a signed-in or signed-out user, and pins every search_path", () => {
    expect(code).not.toMatch(/GRANT EXECUTE[^;]*\b(authenticated|anon|PUBLIC)\b/);
    const functions = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    expect(functions.sort()).toEqual(["compliance_account_change_fields", "compliance_accounts_seed", "compliance_apply_form_link", "compliance_form_link_opened", "compliance_form_link_sent", "compliance_form_links_guard", "compliance_mint_form_link", "compliance_revoke_form_link"]);
    for (const f of functions) expect(code, f).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
    for (const b of code.split("CREATE OR REPLACE FUNCTION public.").slice(1)) {
      const head = b.slice(0, b.indexOf("AS $$"));
      expect(head, b.slice(0, 40)).toMatch(/SET search_path = public/);
    }
    const authenticatedOk = guard.match(/authenticated_ok text\[\] := ARRAY\[([\s\S]*?)\];/)![1];
    for (const f of functions) expect(authenticatedOk).not.toContain(f);
  });

  it("widens messages.content_type from the live constraint without a long lock, and refuses to run if it cannot read it", () => {
    expect(code).toContain("pg_get_constraintdef(c.oid)");
    expect(code).toContain("CHECK (content_type = ANY (%L::text[])) NOT VALID");
    expect(code).toContain("VALIDATE CONSTRAINT messages_content_type_check");
    expect(code).toContain("RAISE EXCEPTION 'could not read the content types");
    expect(code).toContain("RAISE EXCEPTION 'messages has no content_type check to widen'");
  });

  it("turns phone_change into Account change without overwriting an edit: relabelled only while the words are 183's, fields only added when absent", () => {
    const f = fn("compliance_account_change_fields");
    expect(f).toContain("AND t.label = 'Phone number change'");
    expect(f.match(/NOT EXISTS \(SELECT 1 FROM jsonb_array_elements\(t\.fields\) f WHERE f ->> 'key' = '(what_changes|current_email|new_email|child_current_name|child_new_name)'\)/g)).toHaveLength(5);
    expect(f).toContain("AND NOT (e.f ? 'showIf')");
    // what_changes is first and required, offers exactly three choices and never a parent's name
    expect(f).toContain("jsonb_build_array(v_what) || t.fields");
    expect(f).toMatch(/'key', 'what_changes', 'type', 'choice', 'required', true/);
    expect([...f.matchAll(/jsonb_build_object\('value', '(\w+)'/g)].map((m) => m[1])).toEqual(["parent_phone", "parent_email", "child_name"]);
    expect(f).not.toMatch(/parent_name/);
    // the SQL and the TypeScript agree on the definitions
    expect(ACCOUNT_CHANGE_FIELDS.map((x) => x.key)).toEqual(["what_changes", "current_phone", "new_phone", "current_email", "new_email", "child_current_name", "child_new_name"]);
    // (current_phone and new_phone are 183's own fields: only their condition is new)
    for (const x of ACCOUNT_CHANGE_FIELDS.slice(3)) expect(f, x.key).toContain(`'key', '${x.key}'`);
    // four languages on every label
    expect(f.match(/public\.compliance_label\(/g)!.length).toBeGreaterThanOrEqual(10);
    // a workspace made later gets it, and the ones that exist now
    const seed = fn("compliance_accounts_seed");
    for (const c of ["compliance_seed_types", "compliance_intake_fields", "compliance_account_change_fields"]) expect(seed, c).toContain(`PERFORM public.${c}(NEW.id)`);
    expect(seed).toContain("EXCEPTION WHEN OTHERS THEN");
    expect(code).toMatch(/PERFORM public\.compliance_account_change_fields\(a\.id\) FROM public\.accounts a/);
  });

  it("has a verify script that ends in the deliberate rollback, against the real schema, and checks the things above", () => {
    expect(verify).toContain("RAISE EXCEPTION 'ROLLBACK-OK:");
    for (const s of [
      "compliance_form_links", "link_card", "compliance_form", "form_link", "form_submitted", "compliance_mint_form_link", "compliance_form_link_sent", "compliance_revoke_form_link",
      "compliance_form_link_opened", "compliance_apply_form_link", "compliance_account_change_fields", "what_changes", "parent_phone", "parent_email", "child_name",
      "unique_violation", "token_hash", "has_function_privilege", "has_column_privilege", "form_link_invalid", "DISABLE TRIGGER compliance_form_links_guard",
    ]) {
      expect(verify, s).toContain(s);
    }
    expect(verify).toMatch(/INSERT INTO contacts \(id, account_id, phone\)/);
    expect(verify).toMatch(/INSERT INTO conversations \(id, user_id, account_id, contact_id\)/);
    expect(verify).toMatch(/INSERT INTO messages \(conversation_id, sender_type, content_type, content_text, channel_type/);
    expect(verify).not.toMatch(/DELETE FROM contacts|DELETE FROM conversations/);
    // the guard trigger it switches off is switched back on
    expect(verify).toContain("ENABLE TRIGGER compliance_form_links_guard");
  });
});
