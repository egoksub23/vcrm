import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readMigration } from "@/lib/testing/read-migration";

// Guards on the TEXT of migration 191 (add-on roles). The behaviour is proven against a database by supabase/ci/verify-191-addon-roles.sql (run it rolled back
// against production, with 191's text in front until it is applied): that script checks the four permission functions AGREE for every permission and kind
// of person. These checks stop a later edit from quietly undoing the design: add-only, never above the base tier, nobody gives more than they hold, one
// meaning of "holds a permission" in every place that decides it, and tables nobody writes directly.

const sql = readMigration("191_addon_roles.sql").replace(/\r\n/g, "\n");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const verify = readFileSync(join(process.cwd(), "supabase", "ci", "verify-191-addon-roles.sql"), "utf8").replace(/\r\n/g, "\n");

/** The text of one function: from its CREATE line to the `$$;` that ends it. */
const fn = (source: string, name: string): string => {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("$$;", source.indexOf("AS $$", start)) + 3);
};
const noComments = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

describe("migration 191: the tables", () => {
  it("makes three tables, readable by members of the workspace and written by nobody directly", () => {
    for (const t of ["account_addon_roles", "account_addon_role_capabilities", "member_addon_roles"]) {
      expect(code, t).toContain(`CREATE TABLE IF NOT EXISTS public.${t}`);
      expect(code, t).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(code, t).toContain(`REVOKE ALL ON public.${t} FROM PUBLIC, anon, authenticated;`);
      expect(code, t).toContain(`GRANT SELECT ON public.${t} TO authenticated;`);
      expect(code, t).toContain(`GRANT ALL ON public.${t} TO service_role;`);
    }
    // a SELECT policy each, and no policy that writes
    expect(code.match(/CREATE POLICY/g)).toHaveLength(3);
    expect(code.match(/CREATE POLICY \w+ ON public\.\w+ FOR SELECT/g)).toHaveLength(3);
    expect(code).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(code).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)/);
  });

  it("deletes with the workspace, the role or the person, and records only add-only grants (no 'granted' flag that could mean a denial)", () => {
    expect(code).toMatch(/account_id\s+UUID NOT NULL REFERENCES public\.accounts\(id\) ON DELETE CASCADE/);
    expect(code).toMatch(/addon_role_id UUID NOT NULL REFERENCES public\.account_addon_roles\(id\) ON DELETE CASCADE/);
    expect(code).toMatch(/user_id\s+UUID NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
    const caps = code.slice(code.indexOf("CREATE TABLE IF NOT EXISTS public.account_addon_role_capabilities"), code.indexOf("CREATE TABLE IF NOT EXISTS public.member_addon_roles"));
    expect(caps).not.toMatch(/granted\s+BOOLEAN/i);
    expect(caps).toMatch(/PRIMARY KEY \(addon_role_id, capability\)/);
  });

  it("names are unique per workspace, case-blind, and bounded", () => {
    expect(code).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_account_addon_roles_account_name_ci");
    expect(code).toContain("(account_id, lower(btrim(name)))");
    expect(code).toContain("char_length(btrim(name)) BETWEEN 1 AND 80");
    expect(code).toContain("char_length(description) <= 300");
  });

  it("lets an invitation carry add-on roles", () => {
    expect(code).toContain("ADD COLUMN IF NOT EXISTS addon_role_ids UUID[] NOT NULL DEFAULT '{}'");
  });
});

describe("migration 191: one meaning of 'holds a permission'", () => {
  it("an add-on grants a capability only when the base tier is high enough for it: the same floor a custom role has", () => {
    const grants = noComments(fn(sql, "addon_grants_capability"));
    expect(grants).toContain("role_rank(p.account_role) >= role_rank(cc.min_grant_role)");
    expect(grants).toContain("p.account_id = p_account");
    expect(grants).toContain("m.account_id = p.account_id");
    expect(grants).toContain("SECURITY DEFINER");
    expect(grants).toContain("SET search_path = public");
  });

  it("person_has_capability is the base role (or custom role) as before OR an add-on, and nothing else", () => {
    const f = noComments(fn(sql, "person_has_capability"));
    expect(f).toContain("effective_custom_role_capability(p.custom_role_id, p_cap)");
    expect(f).toContain("effective_capability(p.account_id, p.account_role, p_cap)");
    expect(f).toMatch(/OR public\.addon_grants_capability\(p_account, p_user, p_cap\);/);
    expect(f).not.toMatch(/AND NOT|NOT public\.addon/);
  });

  it("has_capability, compliance_user_can, the app's list and the policies' capability_account_ids all use it", () => {
    expect(noComments(fn(sql, "has_capability"))).toContain("SELECT public.person_has_capability(target_account_id, auth.uid(), cap);");
    expect(noComments(fn(sql, "compliance_user_can"))).toContain("SELECT public.person_has_capability(p_account, p_user, p_cap);");
    expect(noComments(fn(sql, "capabilities_for_current_user"))).toContain("public.addon_grants_capability(p.account_id, p.user_id, c.capability)");
    const ids = noComments(fn(sql, "capability_account_ids"));
    expect(ids).toContain("FROM member_addon_roles m");
    expect(ids).toContain("role_rank(p.account_role) >= role_rank(cc.min_grant_role)");
    // the owner is still always in, and the base branches are still there
    expect(ids).toContain("p.account_role = 'owner'");
    expect(ids).toContain("account_role_capabilities arc");
    expect(ids).toContain("role_capabilities rc");
  });

  it("the three notification routers use it, so an add-on that grants approvals.review or incidents.manage is told too", () => {
    expect(noComments(fn(sql, "approvals_notify_reviewers"))).toContain("person_has_capability(p.account_id, p.user_id, 'approvals.review')");
    expect(noComments(fn(sql, "notify_incident_raised"))).toContain("person_has_capability(p.account_id, p.user_id, 'incidents.manage')");
    expect(noComments(fn(sql, "incident_escalation_recipient_ids"))).toContain("person_has_capability(p.account_id, p.user_id, 'incidents.manage')");
    for (const name of ["approvals_notify_reviewers", "notify_incident_raised", "incident_escalation_recipient_ids"]) {
      expect(noComments(fn(sql, name)), name).not.toMatch(/effective_capability\(|effective_custom_role_capability\(/);
    }
  });

  it("is, for each function it rewires, the original's text with only the permission check changed", () => {
    const compare = (migration: string, name: string, drop: RegExp) => {
      const old = readMigration(migration).replace(/\r\n/g, "\n");
      const strip = (s: string) =>
        noComments(s)
          .split("\n")
          .filter((l) => !drop.test(l))
          .map((l) => l.trim())
          .filter(Boolean)
          .join("\n");
      expect(strip(fn(sql, name)), name).toBe(strip(fn(old, name)));
    };
    compare("084_approvals.sql", "approvals_notify_reviewers", /effective_capability|person_has_capability/);
    // 116's check spans a CASE of several lines; both sides drop the lines of the check and nothing else
    compare("116_incident_reporting.sql", "notify_incident_raised", /effective_custom_role_capability|effective_capability|person_has_capability|CASE WHEN p\.custom_role_id|^\s*END\s*$|^\s*\)\s*$|^\s*AND \(\s*$/);
  });

  it("accepting an invitation is 190's function with ONE block added: the add-on roles it carried", () => {
    const old = readMigration("190_invite_accept_purge_flag.sql").replace(/\r\n/g, "\n");
    const tidy = (s: string) =>
      noComments(s)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n");
    const block = /IF cardinality\(v_inv\.addon_role_ids\) > 0 THEN[\s\S]*?ON CONFLICT \(user_id, addon_role_id\) DO NOTHING;\s*END IF;\s*/;
    const now = noComments(fn(sql, "attach_user_to_invited_account"));
    expect(block.test(now)).toBe(true);
    expect(tidy(now.replace(block, ""))).toBe(tidy(fn(old, "attach_user_to_invited_account")));
  });

  it("never removes: nothing in it takes a permission from anybody", () => {
    expect(code).not.toMatch(/NOT public\.addon_grants_capability|AND NOT person_has_capability/);
    expect(noComments(fn(sql, "person_has_capability"))).not.toMatch(/AND NOT|NOT public\.|NOT effective/);
  });
});

describe("migration 191: who may do what", () => {
  const make = noComments(fn(sql, "create_addon_role"));
  const upd = noComments(fn(sql, "update_addon_role"));
  const del = noComments(fn(sql, "delete_addon_role"));
  const give = noComments(fn(sql, "set_member_addon_roles"));

  it("making, editing and deleting an add-on needs roles.manage in the workspace of the role", () => {
    for (const f of [make, upd, del]) {
      expect(f).toContain("has_capability(");
      expect(f).toContain("'roles.manage'");
      expect(f).toContain("You are not a member of this account");
    }
  });

  it("a permission goes into an add-on only if the caller holds it, whichever way it gets there", () => {
    expect(make).toContain("NOT has_capability(p_account_id, v_cap)");
    expect(make).toContain("do not hold it yourself");
    expect(upd).toContain("NOT has_capability(v_role.account_id, v_cap)");
    expect(upd).toContain("do not hold it yourself");
    // taking permissions out needs none: only the ADDED ones are checked
    expect(upd).toMatch(/FOREACH v_cap IN ARRAY v_added LOOP/);
    expect(upd).not.toMatch(/FOREACH v_cap IN ARRAY v_removed/);
  });

  it("giving add-ons needs members.change-role and an admin rank, a target below the caller, never the owner, never oneself, only this workspace's roles", () => {
    expect(give).toContain("v_caller_role NOT IN ('owner', 'admin')");
    expect(give).toContain("has_capability(v_acct, 'members.change-role')");
    expect(give).toContain("p_user_id = v_uid");
    expect(give).toContain("v_t_role = 'owner'");
    expect(give).toContain("role_rank(v_t_role) >= role_rank(v_caller_role)");
    expect(give).toContain("account_id = v_acct");
    expect(give).toContain("v_t_acct <> v_acct");
  });

  it("an add-on is given only by someone who holds every permission in it; taking one away needs none", () => {
    expect(give).toMatch(/FOREACH v_id IN ARRAY v_added LOOP[\s\S]*?NOT has_capability\(v_acct, v_cap\)/);
    expect(give).toContain("which you do not hold yourself");
    expect(give).not.toMatch(/FOREACH v_id IN ARRAY v_removed/);
  });

  it("an invitation's add-ons must be this workspace's, and the inviter must hold every permission in them", () => {
    const f = noComments(fn(sql, "enforce_invitation_addons"));
    expect(f).toContain("account_id = NEW.account_id");
    expect(f).toContain("person_has_capability(NEW.account_id, auth.uid(), v_cap)");
    expect(code).toContain("BEFORE INSERT OR UPDATE OF addon_role_ids, account_id ON public.account_invitations");
  });

  it("every change is in the audit trail, with the names and never a secret", () => {
    expect(make).toContain("'created', 'role'");
    expect(upd).toContain("'capability_changed', 'role'");
    expect(upd).toContain("'updated', 'role'");
    expect(del).toContain("'deleted', 'role'");
    expect(give).toContain("'role_changed', 'member'");
  });

  it("accepting an invitation gives its add-ons, but only the ones that still exist in the inviter's workspace", () => {
    const f = noComments(fn(sql, "attach_user_to_invited_account"));
    expect(f).toContain("INSERT INTO member_addon_roles");
    expect(f).toContain("r.account_id = v_inv.account_id");
    expect(f).toContain("r.id = ANY (v_inv.addon_role_ids)");
    expect(f).toContain("ON CONFLICT (user_id, addon_role_id) DO NOTHING");
    // 190's purge-flag behaviour is kept
    expect(f).toContain("PERFORM set_config('vircle.purge_account', v_old_account_id::text, true);");
    expect(f).toContain("SELECT 1 FROM compliance_requests WHERE account_id = v_old_account_id");
  });

  it("a member who leaves the workspace loses the add-ons of the workspace they left", () => {
    const f = noComments(fn(sql, "member_addon_roles_cleanup"));
    expect(f).toContain("DELETE FROM public.member_addon_roles WHERE user_id = NEW.user_id AND account_id <> NEW.account_id;");
    expect(code).toContain("AFTER UPDATE OF account_id ON public.profiles");
  });
});

describe("migration 191: privileges", () => {
  it("the internal functions are closed to every API role; the public ones to the signed-out role and open to the signed-in", () => {
    for (const sig of ["addon_grants_capability(UUID, UUID, TEXT)", "person_has_capability(UUID, UUID, TEXT)", "member_addon_roles_cleanup()", "enforce_invitation_addons()"]) {
      expect(code, sig).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
    }
    for (const sig of ["create_addon_role(UUID, TEXT, TEXT, TEXT[])", "update_addon_role(UUID, TEXT, TEXT, TEXT[])", "delete_addon_role(UUID)", "set_member_addon_roles(UUID, UUID[])"]) {
      expect(code, sig).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon;`);
      expect(code, sig).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated;`);
    }
  });

  it("every function it makes is SECURITY DEFINER with a pinned search_path", () => {
    const names = ["addon_grants_capability", "person_has_capability", "create_addon_role", "update_addon_role", "delete_addon_role", "set_member_addon_roles", "enforce_invitation_addons", "member_addon_roles_cleanup"];
    for (const n of names) {
      const f = fn(sql, n);
      expect(f, n).toContain("SECURITY DEFINER");
      expect(f, n).toContain("SET search_path = public");
    }
  });

  it("does not touch the base roles' tables, the custom roles' tables or the policies of any other table", () => {
    expect(code).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+(public\.)?(role_capabilities|account_roles|account_role_capabilities|role_capability_defaults|capability_catalogue)\b/);
    expect(code).not.toMatch(/DROP POLICY IF EXISTS (?!account_addon_roles_select|account_addon_role_capabilities_select|member_addon_roles_select)/);
  });
});

describe("migration 191: the verify script", () => {
  it("ends in the deliberate rollback and proves the four functions agree, the rules, the invitation, the audit trail and the privileges", () => {
    expect(verify).toContain("RAISE EXCEPTION 'ROLLBACK-OK:");
    for (const s of [
      "has_capability, capabilities_for_current_user and capability_account_ids disagree",
      "compliance_user_can disagrees",
      "FAIL an add-on lifted a viewer to a write permission",
      "do not hold it yourself",
      "which you do not hold yourself",
      "redeem_invitation('verify-191-ok')",
      "FAIL a member who left the workspace kept its add-on roles",
      "FAIL a deleted add-on role still gives its permission",
      "audit_log",
      "has_function_privilege",
    ]) {
      expect(verify, s).toContain(s);
    }
  });
});
