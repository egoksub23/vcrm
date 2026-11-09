// Loads and changes a school's status options (server side, migration 226). Reads come through the person's connection (row-level security: everyone in the
// school may read); changes use the service connection after the route has checked incidents.configure.

import type { PgDb } from "@/lib/postgres/db";
import { MAX_EXTRA_STATUSES, isBase, makeKey, mergeOptions, parseLabel, type StatusOption, type StatusOptionRow } from "./statuses";

export async function loadStatusRows(db: PgDb, accountId: string): Promise<StatusOptionRow[]> {
  const { data } = await db.from("incident_status_options").select("key, label, base_status, position, is_builtin, is_active").eq("account_id", accountId);
  return (data ?? []) as StatusOptionRow[];
}

export async function loadStatusOptions(db: PgDb, accountId: string): Promise<StatusOption[]> {
  return mergeOptions(await loadStatusRows(db, accountId));
}

export interface StatusesView {
  options: StatusOption[];
  /** How many incidents are in each extra status (an extra that is in use cannot be deleted; it can be hidden). */
  usage: Record<string, number>;
  max: number;
}

export async function loadStatusesView(db: PgDb, accountId: string): Promise<StatusesView> {
  const options = await loadStatusOptions(db, accountId);
  const usage: Record<string, number> = {};
  for (const o of options.filter((x) => !x.builtin)) {
    const { data } = await db.from("incidents").select("id").eq("account_id", accountId).eq("status_key", o.key).limit(1000);
    usage[o.key] = (data ?? []).length;
  }
  return { options, usage, max: MAX_EXTRA_STATUSES };
}

export type ChangeResult = { ok: true } | { ok: false; status: number; error: string };

export type StatusChange =
  | { action: "add"; label: unknown; base: unknown }
  | { action: "rename"; key: unknown; label: unknown }
  | { action: "hide"; key: unknown; active: unknown }
  | { action: "delete"; key: unknown };

/** One change to the school's statuses. `db` is the service connection. */
export async function changeStatuses(db: PgDb, accountId: string, change: StatusChange): Promise<ChangeResult> {
  const rows = await loadStatusRows(db, accountId);
  const taken = new Set(rows.map((r) => r.key));

  if (change.action === "add") {
    const label = parseLabel(change.label);
    if (!label.ok) return { ok: false, status: 400, error: label.error };
    if (!isBase(change.base)) return { ok: false, status: 400, error: "Say which of the six statuses it counts as." };
    if (rows.filter((r) => !r.is_builtin).length >= MAX_EXTRA_STATUSES) return { ok: false, status: 409, error: `A school can add at most ${MAX_EXTRA_STATUSES} statuses.` };
    const options = mergeOptions(rows);
    if (options.some((o) => (o.label ?? "").toLowerCase() === label.value.toLowerCase())) return { ok: false, status: 409, error: "There is already a status with that name." };
    const position = rows.filter((r) => r.base_status === change.base).length;
    const { error } = await db.from("incident_status_options").insert({ account_id: accountId, key: makeKey(label.value, taken), label: label.value, base_status: change.base, position, is_builtin: false, is_active: true });
    return error ? { ok: false, status: 500, error: "Could not add the status." } : { ok: true };
  }

  const key = typeof change.key === "string" ? change.key : "";
  const options = mergeOptions(rows);
  const option = options.find((o) => o.key === key);
  if (!option) return { ok: false, status: 404, error: "Status not found." };

  if (change.action === "rename") {
    const label = parseLabel(change.label);
    if (!label.ok) return { ok: false, status: 400, error: label.error };
    if (options.some((o) => o.key !== key && (o.label ?? "").toLowerCase() === label.value.toLowerCase())) return { ok: false, status: 409, error: "There is already a status with that name." };
    if (option.builtin) {
      const existing = rows.find((r) => r.key === key && r.is_builtin);
      const { error } = existing
        ? await db.from("incident_status_options").update({ label: label.value }).eq("account_id", accountId).eq("key", key)
        : await db.from("incident_status_options").insert({ account_id: accountId, key, label: label.value, base_status: key, position: 0, is_builtin: true, is_active: true });
      return error ? { ok: false, status: 500, error: "Could not rename the status." } : { ok: true };
    }
    const { error } = await db.from("incident_status_options").update({ label: label.value }).eq("account_id", accountId).eq("key", key);
    return error ? { ok: false, status: 500, error: "Could not rename the status." } : { ok: true };
  }

  if (option.builtin) return { ok: false, status: 400, error: "The six built-in statuses can be renamed but not hidden or deleted." };

  if (change.action === "hide") {
    if (typeof change.active !== "boolean") return { ok: false, status: 400, error: "'active' must be true or false" };
    const { error } = await db.from("incident_status_options").update({ is_active: change.active }).eq("account_id", accountId).eq("key", key);
    return error ? { ok: false, status: 500, error: "Could not change the status." } : { ok: true };
  }

  // delete: only an extra status nothing is in
  const { data: using } = await db.from("incidents").select("id").eq("account_id", accountId).eq("status_key", key).limit(1);
  if ((using ?? []).length > 0) return { ok: false, status: 409, error: "Incidents are in this status. Hide it instead, so it is not offered, or move them first." };
  const { error } = await db.from("incident_status_options").delete().eq("account_id", accountId).eq("key", key);
  return error ? { ok: false, status: 500, error: "Could not delete the status." } : { ok: true };
}
