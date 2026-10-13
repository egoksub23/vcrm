import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CAPABILITIES, DEFAULT_CAPABILITIES, getCapability } from "@/lib/auth/capabilities";
import { DEFAULT_OFF_FEATURES, PLATFORM_FEATURES } from "@/lib/platform/features";
import { readMigration } from "@/lib/testing/read-migration";

import { EVENT_KINDS, REQUEST_STATUSES, SOURCES } from "./types";

// Guards on the TEXT of migration 183 (Compliance requests, Part A). The behaviour is proven against a database by
// supabase/ci/verify-183-compliance-requests.sql (run it rolled back against production; it also ran in PGlite for this change, see
// docs/compliance-requests.md section 12). These checks stop a later edit from quietly undoing the design: nothing callable by a signed-in user, the
// maker-checker and retention rules in the database, the sensitive columns kept from the browser, the TypeScript catalogue and the SQL agreeing.

const sql = readMigration("183_compliance_requests.sql").replace(/\r\n/g, "\n");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-183-compliance-requests.sql"), "utf8").replace(/\r\n/g, "\n");
const guard = readFileSync(join(process.cwd(), "supabase", "ci", "verify-guard-catalog.sql"), "utf8").replace(/\r\n/g, "\n");

const CAPS = ["menu.compliance", "compliance.review", "compliance.approve", "compliance.reveal", "compliance.execute", "compliance.manage"];

describe("migration 183", () => {
  it("is idempotent", () => {
    expect(code.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(6);
    expect(code).toMatch(/ON CONFLICT \(capability\) DO UPDATE/);
    expect(code).toMatch(/ON CONFLICT \(role, capability\) DO NOTHING/);
    expect(code).toMatch(/WHERE NOT \(features \? 'compliance'\)/);
    expect(code).toMatch(/ON CONFLICT \(account_id, key\) DO NOTHING/);
    for (const t of ["compliance_requests_guard", "compliance_requests_after_insert", "compliance_requests_no_delete", "compliance_request_events_no_update", "compliance_accounts_seed", "compliance_types_guard"]) {
      expect(code, t).toContain(`DROP TRIGGER IF EXISTS ${t} ON`);
    }
    expect(code.match(/DROP POLICY IF EXISTS/g)).toHaveLength(5);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS compliance_requests_status_idx/);
  });

  it("seeds the six capabilities exactly as the TypeScript catalogue has them (app tier, grantable to agent, Owner and Admin by default, no named role)", () => {
    for (const key of CAPS) {
      expect(getCapability(key), key).toMatchObject({ enforcedBy: "app", minGrantRole: "agent" });
      expect(code).toMatch(new RegExp(`\\('${key.replace(".", "\\.")}',\\s+'agent',\\s+'app'\\)`));
      expect(code).toContain(`('owner', '${key}')`);
      expect(code).toContain(`('admin', '${key}')`);
      expect(code).not.toContain(`('agent', '${key}')`);
      expect(code).not.toContain(`('viewer', '${key}')`);
      expect(DEFAULT_CAPABILITIES.agent.has(key)).toBe(false);
    }
    // every compliance capability the code knows is in the migration, and nothing else
    // (compliance.raise is Part B's, migration 184: migration-184.test.ts checks it)
    const known = CAPABILITIES.map((c) => c.key).filter((k) => (k.startsWith("compliance.") || k === "menu.compliance") && k !== "compliance.raise");
    expect([...known].sort()).toEqual([...CAPS].sort());
    // no custom role is invented (the owner defines Head of Compliance and Compliance Officer in the roles screen)
    expect(code).not.toMatch(/account_roles|Head of Compliance'|Compliance Officer'/);
  });

  it("writes an explicit false of the compliance flag for every workspace and for every new one, and keeps the flags 182 wrote", () => {
    expect(code).toMatch(/SET features = features \|\| '\{"compliance": false\}'::jsonb/);
    const seed = code.slice(code.indexOf("account_platform_seed()"), code.indexOf("account_platform_seed() FROM"));
    for (const f of PLATFORM_FEATURES) expect(seed, f).toContain(`"${f}": false`);
    expect(DEFAULT_OFF_FEATURES).toContain("compliance");
  });

  it("agrees with the TypeScript constants: statuses, sources, event kinds", () => {
    const list = (re: RegExp) => [...(code.match(re)?.[1] ?? "").matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(list(/status\s+TEXT NOT NULL DEFAULT 'received'\s+CHECK \(status IN \(([^)]*)\)/)).toEqual([...REQUEST_STATUSES]);
    expect(list(/source\s+TEXT NOT NULL CHECK \(source IN \(([^)]*)\)/)).toEqual([...SOURCES]);
    // ('notice' is Part B's event kind: migration 184 widens the check, migration-184.test.ts checks it)
    expect(list(/kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)/).sort()).toEqual(EVENT_KINDS.filter((k) => k !== "notice" && k !== "form_link" && k !== "form_submitted").sort());
  });

  it("widens the notification types with compliance_clock and adds the case it is about", () => {
    expect(code).toContain("ARRAY['compliance_clock']");
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS compliance_request_id UUID REFERENCES public\.compliance_requests\(id\) ON DELETE SET NULL/);
  });

  it("scopes every table to its workspace with composite foreign keys, and gives every case-owned table the case's pair", () => {
    expect(code).toMatch(/CONSTRAINT compliance_requests_type_fk FOREIGN KEY \(account_id, type_key\)\s+REFERENCES public\.compliance_request_types \(account_id, key\)/);
    for (const t of ["events", "checklist", "files"]) {
      expect(code, t).toMatch(new RegExp(`CONSTRAINT compliance_request_${t}_request_fk FOREIGN KEY \\(request_id, account_id\\)\\s+REFERENCES public\\.compliance_requests \\(id, account_id\\) ON DELETE CASCADE`));
    }
    expect(code).toMatch(/CONSTRAINT compliance_requests_id_account UNIQUE \(id, account_id\)/);
    expect(code).toMatch(/CONSTRAINT compliance_requests_reference UNIQUE \(account_id, reference\)/);
    // the links point at things of the same workspace (a check, because those tables are keyed by id alone)
    for (const k of ["contact", "conversation", "ticket", "incident"]) expect(code).toContain(`compliance_link_other_workspace: ${k}`);
  });

  it("turns row level security on everywhere, grants the browser SELECT only, and keeps the ciphertext and the storage path out of its reach", () => {
    expect(code.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(6);
    expect(code).toMatch(/REVOKE ALL ON public\.compliance_request_types, public\.compliance_request_counters, public\.compliance_requests,[\s\S]*?FROM PUBLIC, anon, authenticated/);
    expect(code).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE|TRUNCATE|ALL)[^;]*\bTO\b[^;]*(anon|authenticated)/);
    const requestsGrant = code.slice(code.indexOf("GRANT SELECT (id, account_id, reference"), code.indexOf("ON public.compliance_requests TO authenticated"));
    expect(requestsGrant).not.toContain("data_enc");
    const filesGrant = code.slice(code.indexOf("GRANT SELECT (id, account_id, request_id, field_key"), code.indexOf("ON public.compliance_request_files TO authenticated"));
    expect(filesGrant).not.toMatch(/\bpath\b/);
    expect(code).not.toMatch(/USING\s*\(\s*true\s*\)/i);
    expect(code.match(/CREATE POLICY/g)).toHaveLength(5);
    expect(code).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  it("shows a case to a holder of menu.compliance or the person who raised it, and nobody else", () => {
    expect(code).toMatch(/FOR SELECT TO authenticated\s+USING \(public\.has_capability\(account_id, 'menu\.compliance'\) OR created_by = auth\.uid\(\)\)/);
    expect(code.match(/has_capability\(r\.account_id, 'menu\.compliance'\) OR r\.created_by = auth\.uid\(\)/g)).toHaveLength(3);
  });

  it("changes status only through compliance_transition: a guard refuses every other write of a protected column, from any role", () => {
    expect(code).toMatch(/RAISE EXCEPTION 'compliance_request_change_refused: use the compliance functions' USING ERRCODE = '42501'/);
    expect(code).toMatch(/COALESCE\(current_setting\('vircle\.compliance_fn', true\), ''\) = 'on'/);
    // the only unguarded changes: a link emptied by the cleanup of what it pointed at, and the re-encryption job's rewrite of data_enc
    expect(code).toContain("- 'data_enc' - 'updated_at'");
    expect(code.match(/set_config\('vircle\.compliance_fn', 'on', true\)/g)!.length).toBeGreaterThanOrEqual(6);
    // every function that sets the switch turns it off again before returning
    expect(code.match(/set_config\('vircle\.compliance_fn', 'off', true\)/g)!.length).toBeGreaterThanOrEqual(6);
  });

  it("enforces the maker-checker rule and the capability each move needs inside compliance_transition", () => {
    const fn = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION public.compliance_transition("), code.indexOf("ALTER FUNCTION public.compliance_transition("));
    expect(fn).toContain("FOR UPDATE");
    expect(fn).toMatch(/p_actor::TEXT = COALESCE\(r\.identity_check ->> 'verified_by', ''\) OR p_actor::TEXT = COALESCE\(r\.identity_check ->> 'recorded_by', ''\)/);
    expect(fn).toContain("compliance_maker_checker");
    for (const cap of ["compliance.review", "compliance.approve", "compliance.execute"]) expect(fn, cap).toContain(`'${cap}'`);
    expect(fn).toContain("compliance_dues_outstanding");
    expect(fn).toContain("compliance_checklist_incomplete");
    expect(fn).toContain("compliance_identity_not_passed");
  });

  it("refuses deleting a case, its events, checklist and files while retention_until is in the future, with the purge exception only", () => {
    expect(code).toMatch(/BEFORE DELETE ON public\.compliance_requests/);
    expect(code).toMatch(/BEFORE TRUNCATE ON public\.compliance_requests/);
    for (const t of ["compliance_request_events", "compliance_request_checklist", "compliance_request_files"]) expect(code, t).toMatch(new RegExp(`BEFORE DELETE ON public\\.${t}`));
    expect(code).toMatch(/current_setting\('vircle\.purge_account', true\) = OLD\.account_id::text/);
    expect(code).toMatch(/current_user NOT IN \('anon', 'authenticated', 'service_role'\)/);
    expect(code).toMatch(/OLD\.retention_until <= now\(\)/);
    expect(code).toMatch(/BEFORE UPDATE ON public\.compliance_request_events/);
    expect(code).toContain("GREATEST(OLD.retention_until, NEW.retention_until)");
    expect(code).toContain("interval '7 years'");
    // the retention triggers are plain functions: current_user must be the caller's role
    const retention = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION public.compliance_requests_no_delete"), code.indexOf("ALTER FUNCTION public.compliance_requests_no_delete"));
    expect(retention).not.toMatch(/SECURITY DEFINER/);
  });

  it("makes no function callable by a signed-in or signed-out user, and pins every search_path", () => {
    expect(code).not.toMatch(/GRANT EXECUTE[^;]*\b(authenticated|anon|PUBLIC)\b/);
    const functions = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]).filter((n) => n.startsWith("compliance_") || n === "account_platform_seed");
    expect(functions.length).toBeGreaterThanOrEqual(19);
    for (const f of functions) expect(code, f).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
    const bodies = code.split("CREATE OR REPLACE FUNCTION public.").slice(1);
    for (const b of bodies) {
      const head = b.slice(0, b.indexOf("AS $$"));
      expect(head, b.slice(0, 40)).toMatch(/SET search_path = public/);
    }
    // every SECURITY DEFINER function that is not a trigger is for the service role
    for (const f of functions.filter((n) => !/(guard|after_insert|no_delete|no_update|accounts_seed|platform_seed)$/.test(n))) expect(code, f).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f}\\([^)]*\\) TO service_role`));
  });

  it("creates the private bucket, needing no entry in the guard catalogue's list of public ones", () => {
    expect(code).toMatch(/'compliance-files', 'compliance-files', FALSE/);
    expect(code).toMatch(/public = FALSE/);
    const publicList = guard.match(/public_buckets text\[\] := ARRAY\[([^\]]*)\]/)![1];
    expect(publicList).not.toContain("compliance");
    // and no function was added to the reviewed lists: none is callable by a browser role
    const authenticatedOk = guard.match(/authenticated_ok text\[\] := ARRAY\[([\s\S]*?)\];/)![1];
    expect(authenticatedOk).not.toContain("compliance");
  });

  it("has a verify script that ends in the deliberate rollback and checks the things above", () => {
    expect(verify).toContain("RAISE EXCEPTION 'ROLLBACK-OK:");
    for (const s of ["compliance_transition", "maker_checker", "compliance_clock_alert_sweep", "retained data", "vircle.purge_account", "workspace_export_manifest", "data_enc", "set_role_capabilities", "features ? 'compliance'", "compliance-files"]) {
      expect(verify, s).toContain(s);
    }
  });
});
