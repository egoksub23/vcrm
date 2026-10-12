import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_CAPABILITIES, getCapability } from "@/lib/auth/capabilities";
import { DEFAULT_OFF_FEATURES, PLATFORM_FEATURES } from "@/lib/platform/features";
import { readMigration } from "@/lib/testing/read-migration";

// Guards on the TEXT of migration 182 (KYC review). The behaviour is proven against a database by supabase/ci/verify-182-kyc-review.sql (run it rolled
// back against production; it also ran in PGlite for this change, see docs/kyc-review.md section 9). These checks stop a later edit from quietly
// undoing the design: a default-off flag, a log nobody can write from a browser or change afterwards, and no new function a signed-in user can call.

const sql = readMigration("182_kyc_review.sql").replace(/\r\n/g, "\n");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-182-kyc-review.sql"), "utf8").replace(/\r\n/g, "\n");

describe("migration 182", () => {
  it("is idempotent", () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS public\.kyc_access_log/);
    expect(code.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(2);
    expect(code).toMatch(/DROP POLICY IF EXISTS kyc_access_log_select/);
    expect(code).toMatch(/DROP TRIGGER IF EXISTS kyc_access_log_no_change/);
    expect(code).toMatch(/DROP TRIGGER IF EXISTS kyc_access_log_no_truncate/);
    expect(code).toMatch(/ON CONFLICT \(capability\) DO UPDATE/);
    expect(code).toMatch(/ON CONFLICT \(role, capability\) DO NOTHING/);
    expect(code).toMatch(/WHERE NOT \(features \? 'kyc'\)/);
  });

  it("seeds the three capabilities exactly as the TypeScript catalogue has them (app tier, grantable to agent, Owner and Admin by default)", () => {
    for (const key of ["menu.kyc", "kyc.view", "kyc.reveal"]) {
      expect(getCapability(key), key).toMatchObject({ enforcedBy: "app", minGrantRole: "agent" });
      expect(code).toContain(`('${key}'`);
      expect(code).toMatch(new RegExp(`\\('${key.replace(".", "\\.")}',\\s+'agent',\\s+'app'\\)`));
      expect(code).toContain(`('owner', '${key}')`);
      expect(code).toContain(`('admin', '${key}')`);
      expect(code).not.toContain(`('agent', '${key}')`);
      expect(code).not.toContain(`('viewer', '${key}')`);
      expect(DEFAULT_CAPABILITIES.agent.has(key)).toBe(false);
    }
  });

  it("writes an explicit false of the kyc flag for every existing workspace and for every new one (the signup seed)", () => {
    expect(code).toMatch(/SET features = features \|\| '\{"kyc": false\}'::jsonb/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.account_platform_seed\(\)/);
    const seed = code.slice(code.indexOf("account_platform_seed()"), code.indexOf("account_platform_seed() FROM"));
    for (const f of ["incidents", "jira", "vircle_chat", "sign", "sign_merchant", "kyc"]) expect(seed, f).toMatch(new RegExp(`"${f}": false`));
    // and the seed names every flag the console offers
    for (const f of PLATFORM_FEATURES) expect(seed, f).toContain(`"${f}": false`);
    // the code reads an absent key as off too
    expect(DEFAULT_OFF_FEATURES).toContain("kyc");
  });

  it("makes the access log readable by workspace admins and owners only, and writable by nobody in a browser", () => {
    expect(code).toMatch(/ALTER TABLE public\.kyc_access_log ENABLE ROW LEVEL SECURITY/);
    expect(code).toMatch(/REVOKE ALL ON public\.kyc_access_log FROM PUBLIC, anon, authenticated/);
    expect(code).toMatch(/GRANT SELECT ON public\.kyc_access_log TO authenticated/);
    expect(code.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(code).toMatch(/FOR SELECT TO authenticated\s+USING \(public\.is_account_member\(account_id, 'admin'::account_role_enum\)\)/);
    expect(code).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(code).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE|TRUNCATE|ALL)[^;]*kyc_access_log[^;]*TO[^;]*(anon|authenticated)/);
    expect(code).not.toMatch(/USING\s*\(\s*true\s*\)/i);
  });

  it("makes the access log append-only, with only the workspace-purge exception, and keeps no key, image or value in it", () => {
    expect(code).toMatch(/BEFORE UPDATE OR DELETE ON public\.kyc_access_log/);
    expect(code).toMatch(/BEFORE TRUNCATE ON public\.kyc_access_log/);
    expect(code).toMatch(/current_setting\('vircle\.purge_account', true\) = OLD\.account_id::text/);
    expect(code).toMatch(/current_user NOT IN \('anon', 'authenticated', 'service_role'\)/);
    expect(code).toMatch(/account_id\s+UUID NOT NULL REFERENCES public\.accounts\(id\) ON DELETE CASCADE/);
    // no foreign key on the person: deleting a login must not touch a logged row
    expect(code).toMatch(/user_id\s+UUID,/);
    const table = code.slice(code.indexOf("CREATE TABLE IF NOT EXISTS public.kyc_access_log"), code.indexOf(");", code.indexOf("CREATE TABLE IF NOT EXISTS public.kyc_access_log")));
    const columns = [...table.matchAll(/^\s{2}(\w+)\s+(?:UUID|TEXT|TIMESTAMPTZ)/gm)].map((m) => m[1]);
    expect(columns).toEqual(["id", "account_id", "user_id", "action", "friend_id", "validation_id", "outcome", "created_at"]);
    expect(table).toContain("CHECK (action IN ('lookup', 'list', 'view_image', 'reveal', 'config_error'))");
    expect(table).toContain("CHECK (outcome IN ('ok', 'not_found', 'forbidden', 'error'))");
    expect(table).toMatch(/friend_id\s+TEXT CHECK \(friend_id IS NULL OR length\(friend_id\) BETWEEN 1 AND 100\)/);
  });

  it("indexes the log by (account, time) and (account, friend id)", () => {
    expect(code).toMatch(/kyc_access_log_account_time_idx\s+ON public\.kyc_access_log \(account_id, created_at DESC\)/);
    expect(code).toMatch(/kyc_access_log_account_friend_idx\s+ON public\.kyc_access_log \(account_id, friend_id\)/);
  });

  it("adds no function a signed-in or signed-out user can call: the one new function is a plain trigger function, and the replaced seed is a trigger", () => {
    const secdef = code.match(/SECURITY\s+DEFINER/gi) ?? [];
    expect(secdef).toHaveLength(1); // account_platform_seed, already reviewed (a trigger)
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.kyc_access_log_append_only\(\) FROM PUBLIC, anon, authenticated/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.account_platform_seed\(\) FROM PUBLIC, anon, authenticated/);
    expect(code.match(/SET search_path = public/g)).toHaveLength(2);
    expect(code).not.toMatch(/GRANT EXECUTE/);
  });

  it("has a verify script that ends in the deliberate rollback and checks the things above", () => {
    expect(verify).toContain("RAISE EXCEPTION 'ROLLBACK-OK:");
    for (const s of ["menu.kyc", "kyc.view", "kyc.reveal", "kyc_access_log", "append-only", "features ? 'kyc'", "purge_account", "delete_workspace_data", "workspace_export_manifest", "set_role_capabilities"]) {
      expect(verify, s).toContain(s);
    }
  });
});
