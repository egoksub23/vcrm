// Server-side loaders shared by the Setup routes. They take a PgDb (user-scoped for reads so row-level security applies; admin for seeding).

import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import type { IncidentSeverityLevel, IncidentTypeCatalogueEntry } from "@/lib/incidents/standard-types";
import { STEP_ROLE, type IncidentRule } from "./rules";
import {
  resolveRole,
  type IncidentContact,
  type IncidentRole,
  type IncidentRoleMember,
  type ResolveWarning,
} from "./roles";

export interface RoleView extends IncidentRole {
  members: (IncidentRoleMember & { contact: IncidentContact | null })[];
  /** Why this role would reach nobody today (empty when it is fine, and always empty for per-incident roles). */
  warnings: ResolveWarning[];
  /** How many switched-on rules tell this role. */
  used_by: number;
}

export interface Directory {
  roles: RoleView[];
  contacts: IncidentContact[];
}

/** Creates the starter roles the first time Setup is opened. Service role only (the SQL function is not callable by browser roles). */
export async function ensureStarterRoles(accountId: string, admin: PgDb = createAdminPgDb()): Promise<void> {
  await admin.rpc("seed_incident_roles", { p_account_id: accountId });
}

export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function rolesUsedBy(rules: readonly Pick<IncidentRule, "actions" | "enabled">[]): Map<string, number> {
  const used = new Map<string, number>();
  for (const r of rules) {
    if (!r.enabled) continue;
    const keys = new Set(r.actions.flatMap((a) => (a.type === "notify" ? [a.role_key] : [])));
    for (const k of keys) if (k !== STEP_ROLE) used.set(k, (used.get(k) ?? 0) + 1);
  }
  return used;
}

export async function loadDirectory(db: PgDb, accountId: string, today = todayUtc()): Promise<Directory> {
  const [roles, members, contacts, rules] = await Promise.all([
    db.from("incident_roles").select("*").eq("account_id", accountId).order("sort_order").order("created_at"),
    db.from("incident_role_members").select("*").eq("account_id", accountId).order("position"),
    db.from("incident_contacts").select("*").eq("account_id", accountId).order("name"),
    db.from("incident_rules").select("actions, enabled").eq("account_id", accountId),
  ]);
  const allContacts = (contacts.data ?? []) as IncidentContact[];
  const allMembers = (members.data ?? []) as IncidentRoleMember[];
  const used = rolesUsedBy((rules.data ?? []) as Pick<IncidentRule, "actions" | "enabled">[]);
  const byId = new Map(allContacts.map((c) => [c.id, c]));

  const views: RoleView[] = ((roles.data ?? []) as IncidentRole[]).map((role) => {
    const own = allMembers.filter((m) => m.role_id === role.id);
    return {
      ...role,
      members: own.map((m) => ({ ...m, contact: byId.get(m.contact_id) ?? null })),
      warnings: role.kind === "fixed" ? resolveRole({ role, members: own, contacts: allContacts, today }).warnings : [],
      used_by: used.get(role.key) ?? 0,
    };
  });
  return { roles: views, contacts: allContacts };
}

export interface ActiveTemplate {
  standardId: string;
  name: string;
  categories: IncidentTypeCatalogueEntry[];
  severities: IncidentSeverityLevel[];
}

/** The school's one active template with its categories and severity levels, or null when none is set. */
export async function loadActiveTemplate(db: PgDb, accountId: string): Promise<ActiveTemplate | null> {
  const { data: active } = await db.from("account_incident_standards").select("standard_id").eq("account_id", accountId).eq("is_active", true);
  const ids = ((active ?? []) as { standard_id: string }[]).map((r) => r.standard_id);
  if (ids.length === 0) return null;
  const { data: tpl } = await db.from("incident_standards").select("id, name").in("id", ids).eq("kind", "template").limit(1);
  const std = ((tpl ?? []) as { id: string; name: string }[])[0];
  if (!std) return null;
  const [cats, sevs] = await Promise.all([
    db.from("incident_type_catalogue").select("*").eq("standard_id", std.id).order("position"),
    db.from("incident_severity_levels").select("*").eq("standard_id", std.id).order("position"),
  ]);
  return {
    standardId: std.id,
    name: std.name,
    categories: (cats.data ?? []) as IncidentTypeCatalogueEntry[],
    severities: (sevs.data ?? []) as IncidentSeverityLevel[],
  };
}

/** The level a "serious or worse" recipe means on this template: the second most serious one (or the only one). */
export function seriousLevel(severities: readonly Pick<IncidentSeverityLevel, "slug" | "position">[]): string {
  const sorted = [...severities].sort((a, b) => a.position - b.position);
  return (sorted[1] ?? sorted[0])?.slug ?? "high";
}

/**
 * For "Try it": who each role would reach right now. A per-incident role has no fixed people, so it shows as a stand-in ("whoever reported it")
 * instead of a warning, because it is worked out when a real incident exists.
 */
export function previewResolver(directory: Directory, today = todayUtc()) {
  return (roleKey: string) => {
    const role = directory.roles.find((r) => r.key === roleKey);
    if (!role) return { recipients: [], warnings: ["no_members" as ResolveWarning] };
    if (role.kind === "per_incident") {
      const who: Record<string, string> = { reporter: "whoever reported it", incident_lead: "the incident lead", guardian: "the parent or guardian" };
      return {
        recipients: [{ contactId: null, userId: null, name: who[role.dynamic_source ?? ""] ?? "the person on the incident", channel: "email" as const, address: "", roleKey }],
        warnings: [] as ResolveWarning[],
      };
    }
    return resolveRole({ role, members: role.members, contacts: directory.contacts, today });
  };
}
