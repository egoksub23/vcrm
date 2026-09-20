// ============================================================
// Who should be notified about something that needs a capability?
//
// Cron jobs and background work (the AI budget alert, the SLA sweep)
// run with the service role, so they cannot call `requireCapability`.
// They used to notify "every owner/admin"; now they notify the members
// who currently HOLD the capability, which by default is exactly the
// same set (owner + admin) until an Owner/Admin edits a role.
//
// `selectCapabilityRecipients` is pure (unit-tested);
// `loadCapabilityRecipients` does the two reads with whatever client
// it is given (the service role in practice).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  overridesFromRows,
  resolveCapabilities,
  roleCanBeGranted,
} from "./capabilities";
import { ACCOUNT_ROLES, isAccountRole, type AccountRole } from "./roles";

export interface RecipientMember {
  user_id: string;
  account_role: string;
}

export interface RoleOverrideRow {
  role: string;
  capability: string;
  granted: boolean;
}

/**
 * User ids of the members whose role holds `capability`.
 *
 * `roles` narrows the candidates (for example owner/admin only, so a
 * grant to a lower role does not widen who gets pinged). Members with an
 * unknown role are skipped.
 */
export function selectCapabilityRecipients(
  members: readonly RecipientMember[] | null | undefined,
  overrideRows: readonly RoleOverrideRow[] | null | undefined,
  capability: string,
  roles?: readonly AccountRole[],
): string[] {
  const rowsByRole = new Map<string, RoleOverrideRow[]>();
  for (const row of overrideRows ?? []) {
    const list = rowsByRole.get(row.role) ?? [];
    list.push(row);
    rowsByRole.set(row.role, list);
  }

  const holds = new Map<AccountRole, boolean>();
  const out: string[] = [];
  for (const m of members ?? []) {
    const role = m.account_role;
    if (!isAccountRole(role)) continue;
    if (roles && !roles.includes(role)) continue;
    let ok = holds.get(role);
    if (ok === undefined) {
      ok = resolveCapabilities(
        role,
        overridesFromRows(rowsByRole.get(role)),
      ).has(capability);
      holds.set(role, ok);
    }
    if (ok) out.push(m.user_id);
  }
  return out;
}

/** Roles that could ever hold `capability` (default or by an override). */
export function candidateRoles(
  capability: string,
  roles?: readonly AccountRole[],
): AccountRole[] {
  return ACCOUNT_ROLES.filter(
    (r) =>
      (r === "owner" || roleCanBeGranted(r, capability)) &&
      (!roles || roles.includes(r)),
  );
}

/**
 * Load the members of `accountId` who hold `capability`. Reads the
 * account's `role_capabilities` overrides; if that read fails (or the
 * table is missing) the defaults apply, which equal the old owner/admin
 * behaviour. Notifications are not a security boundary, so this does
 * not fail closed. Never throws on a read error.
 */
export async function loadCapabilityRecipients(
  db: SupabaseClient,
  accountId: string,
  capability: string,
  options: { roles?: readonly AccountRole[] } = {},
): Promise<string[]> {
  const candidates = candidateRoles(capability, options.roles);
  if (candidates.length === 0) return [];

  const { data: members, error: membersErr } = await db
    .from("profiles")
    .select("user_id, account_role")
    .eq("account_id", accountId)
    .in("account_role", candidates);
  if (membersErr || !members || members.length === 0) return [];

  const { data: rows, error: rowsErr } = await db
    .from("role_capabilities")
    .select("role, capability, granted")
    .eq("account_id", accountId)
    .eq("capability", capability)
    .in("role", candidates.filter((r) => r !== "owner"));
  if (rowsErr) {
    console.error("[capability recipients] overrides read failed:", rowsErr);
  }

  return selectCapabilityRecipients(
    members as RecipientMember[],
    rowsErr ? [] : (rows as RoleOverrideRow[] | null),
    capability,
    options.roles,
  );
}
