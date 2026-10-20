// ============================================================
// Add-on roles (migration 191), the parts the API routes and the screens share: the shapes, the checks on what a request sends, and how the database's
// refusals are worded. A person has ONE base role and may have any number of add-on roles on top; an add-on is a named set of permissions that only ADDS.
//
// Pure apart from `rpcErrorToResponse` (which builds a NextResponse); no I/O.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { isCapabilityKey } from "./capabilities";
import type { AccountRole } from "./roles";

export const ADDON_NAME_MAX = 80;
export const ADDON_DESCRIPTION_MAX = 300;
/** Most permissions one add-on may name, and most add-ons one person or invitation may carry (the database enforces the second too). */
export const ADDON_CAPABILITIES_MAX = 300;
export const ADDONS_PER_PERSON_MAX = 50;

/** What GET /api/account/roles/addons lists. `capabilities` is only sent to people who manage roles. */
export interface AddonRoleEntry {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  capabilityCount: number;
  /** The lowest base role at which every permission in it applies; below it some of them have no effect (the screens say so when it is given). */
  minBaseRole: AccountRole;
  /** Whether the caller may edit and delete it (roles.manage). */
  editable: boolean;
  capabilities?: string[];
}

export interface AddonRoleListResponse {
  addons: AddonRoleEntry[];
}

/** An add-on role as a member or an invitation carries it. */
export interface AddonRoleRef {
  id: string;
  name: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A name: trimmed text of 1 to 80 characters. */
export function parseAddonName(raw: unknown): Parsed<string> {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "Give the role a name" };
  const v = raw.trim();
  if (v.length > ADDON_NAME_MAX) return { ok: false, error: `The name is too long (${ADDON_NAME_MAX} characters at most)` };
  return { ok: true, value: v };
}

/** A description: text of up to 300 characters; an empty one is allowed (and clears it). */
export function parseAddonDescription(raw: unknown): Parsed<string> {
  if (typeof raw !== "string") return { ok: false, error: "The description must be text" };
  const v = raw.trim();
  if (v.length > ADDON_DESCRIPTION_MAX) return { ok: false, error: `The description is too long (${ADDON_DESCRIPTION_MAX} characters at most)` };
  return { ok: true, value: v };
}

/** A list of permission keys that all exist in the catalogue, without repeats. The database checks them again. */
export function parseCapabilityKeys(raw: unknown): Parsed<string[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "'capabilities' must be a list of permission keys" };
  if (raw.length > ADDON_CAPABILITIES_MAX) return { ok: false, error: "Too many permissions in one role" };
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k !== "string" || !isCapabilityKey(k)) return { ok: false, error: `Unknown permission: ${typeof k === "string" ? k.slice(0, 80) : String(k)}` };
    if (!out.includes(k)) out.push(k);
  }
  return { ok: true, value: out };
}

/** A list of add-on role ids, without repeats. */
export function parseAddonRoleIds(raw: unknown): Parsed<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "'addonRoleIds' must be a list of role ids" };
  if (raw.length > ADDONS_PER_PERSON_MAX) return { ok: false, error: `At most ${ADDONS_PER_PERSON_MAX} add-on roles at once` };
  const out: string[] = [];
  for (const id of raw) {
    if (!isUuid(id)) return { ok: false, error: "'addonRoleIds' must be a list of role ids" };
    const v = id.toLowerCase();
    if (!out.includes(v)) out.push(v);
  }
  return { ok: true, value: out };
}

/** The database's refusals, in the statuses the other role routes use: 42501 forbidden, 22023 bad input, 23505 the name is taken. */
export function rpcErrorToResponse(err: PostgrestError, what = "save the add-on role"): NextResponse {
  if (err.code === "42501") return NextResponse.json({ error: err.message }, { status: 403 });
  if (err.code === "22023") return NextResponse.json({ error: err.message }, { status: 400 });
  if (err.code === "23505") return NextResponse.json({ error: "There is already a role with that name" }, { status: 409 });
  console.error(`[add-on roles] unexpected RPC error while trying to ${what}:`, err);
  return NextResponse.json({ error: `Failed to ${what}` }, { status: 500 });
}
