// ============================================================
// Pure helpers for the Roles & permissions screen. No React, no I/O,
// so every rule the screen applies (what counts as a change, what is
// sent to the server, why a switch is greyed) is unit-tested.
//
// The draft is stored as sparse EDITS on top of the role's saved
// effective set (capability -> desired value), never as a full copy.
// That way a refetch after somebody else changed the role can never
// resurrect stale values: the draft is always "saved + my edits".
// ============================================================

import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  DEFAULT_CAPABILITIES,
  diffCapabilities,
  getCapability,
  switchBlockReason,
  type CapabilityDef,
  type CapabilityGroup,
  type SwitchBlockReason,
} from "@/lib/auth/capabilities";
import type { AccountRole } from "@/lib/auth/roles";

/** Sparse draft: only capabilities the person flipped away from saved. */
export type DraftEdits = Readonly<Record<string, boolean>>;

/** Reason a switch is greyed. `owner-locked` is the Owner special case. */
export type RowBlockReason = SwitchBlockReason | "owner-locked";

// ------------------------------------------------------------
// Saved / draft / default
// ------------------------------------------------------------

/** Saved effective capability set of a role, from the API's list. */
export function savedSet(effective: readonly string[]): Set<string> {
  return new Set(effective.filter((k) => getCapability(k) !== undefined));
}

/** Drop unknown keys and edits that equal the saved value. */
export function normalizeEdits(
  saved: ReadonlySet<string>,
  edits: DraftEdits | undefined | null,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [cap, want] of Object.entries(edits ?? {})) {
    if (getCapability(cap) === undefined) continue;
    if (saved.has(cap) === want) continue;
    out[cap] = want;
  }
  return out;
}

/** The effective draft: saved with the edits laid over it. */
export function draftSet(
  saved: ReadonlySet<string>,
  edits: DraftEdits | undefined | null,
): Set<string> {
  const out = new Set(saved);
  for (const [cap, want] of Object.entries(normalizeEdits(saved, edits))) {
    if (want) out.add(cap);
    else out.delete(cap);
  }
  return out;
}

/** Record one switch flip; flipping back to the saved value removes the edit. */
export function setEdit(
  saved: ReadonlySet<string>,
  edits: DraftEdits | undefined | null,
  cap: string,
  granted: boolean,
): Record<string, boolean> {
  const next: Record<string, boolean> = { ...normalizeEdits(saved, edits) };
  if (saved.has(cap) === granted) delete next[cap];
  else next[cap] = granted;
  return next;
}

/** Edits that turn `saved` into `desired` (used by presets and reset). */
export function editsFromDesired(
  saved: ReadonlySet<string>,
  desired: ReadonlySet<string>,
): Record<string, boolean> {
  return diffCapabilities(saved, desired);
}

/** Number of capabilities whose draft value differs from saved. */
export function countChanges(
  saved: ReadonlySet<string>,
  edits: DraftEdits | undefined | null,
): number {
  return Object.keys(normalizeEdits(saved, edits)).length;
}

/** Does the draft value of `cap` differ from the role's built-in default? */
export function differsFromDefault(
  role: AccountRole,
  draft: ReadonlySet<string>,
  cap: string,
): boolean {
  return draft.has(cap) !== DEFAULT_CAPABILITIES[role].has(cap);
}

/** How many capabilities differ from the role default in the draft. */
export function countDifferingFromDefault(
  role: AccountRole,
  draft: ReadonlySet<string>,
): number {
  return CAPABILITIES.filter((c) => differsFromDefault(role, draft, c.key))
    .length;
}

// ------------------------------------------------------------
// What is sent to the server
// ------------------------------------------------------------

/**
 * The `changes` body for PUT /api/account/roles/[role]: only keys whose
 * draft value differs from the SAVED effective state. `true`/`false`
 * for a grant/revoke, `null` when the desired value equals the role's
 * default (the server then deletes the override row instead of storing
 * a pointless one).
 */
export function buildChangesPayload(
  role: AccountRole,
  saved: ReadonlySet<string>,
  draft: ReadonlySet<string>,
): Record<string, boolean | null> {
  const diff = diffCapabilities(saved, draft);
  const out: Record<string, boolean | null> = {};
  for (const [cap, want] of Object.entries(diff)) {
    out[cap] = want === DEFAULT_CAPABILITIES[role].has(cap) ? null : want;
  }
  return out;
}

// ------------------------------------------------------------
// Greyed switches
// ------------------------------------------------------------

/**
 * Why clicking the switch of `cap` is refused for the editor, or null
 * when it may be flipped. `on` is the switch's CURRENT (draft) value, so
 * the click would set it to `!on`.
 *
 * Turning off is always allowed for an editable role. Turning on is
 * restricted by the database guardrails, except when the role already
 * holds the capability in its SAVED state (the click merely undoes an
 * unsaved removal, and nothing is sent for it).
 */
export function rowBlockReason(input: {
  editorRole: AccountRole;
  editorCaps: ReadonlySet<string> | readonly string[];
  targetRole: AccountRole;
  cap: string;
  on: boolean;
  saved: ReadonlySet<string>;
}): RowBlockReason | null {
  const { editorRole, editorCaps, targetRole, cap, on, saved } = input;
  if (targetRole === "owner") return "owner-locked";
  const wantGranted = !on;
  // Undoing a draft removal never reaches the server.
  const effectiveWant = wantGranted && saved.has(cap) ? false : wantGranted;
  return switchBlockReason({
    editorRole,
    editorCaps,
    targetRole,
    cap,
    wantGranted: effectiveWant,
  });
}

/**
 * Bulk desired sets (preset, reset to default) may ask for grants the
 * editor cannot make. Clamp them: a capability the role does not hold
 * today and cannot be given stays off. Removals always go through.
 */
export function clampDesired(input: {
  editorRole: AccountRole;
  editorCaps: ReadonlySet<string> | readonly string[];
  targetRole: AccountRole;
  saved: ReadonlySet<string>;
  desired: ReadonlySet<string>;
}): { desired: Set<string>; skipped: string[] } {
  const { editorRole, editorCaps, targetRole, saved, desired } = input;
  const out = new Set(desired);
  const skipped: string[] = [];
  for (const c of CAPABILITIES) {
    if (!out.has(c.key) || saved.has(c.key)) continue;
    const reason = switchBlockReason({
      editorRole,
      editorCaps,
      targetRole,
      cap: c.key,
      wantGranted: true,
    });
    if (reason !== null) {
      out.delete(c.key);
      skipped.push(c.key);
    }
  }
  return { desired: out, skipped };
}

// ------------------------------------------------------------
// Search, filter, group
// ------------------------------------------------------------

export interface CapabilityText {
  label: string;
  description: string;
}

/** Filter by free text (label, description, key) and "only changed". */
export function filterCapabilities(input: {
  query: string;
  onlyChanged: boolean;
  role: AccountRole;
  draft: ReadonlySet<string>;
  text: (cap: CapabilityDef) => CapabilityText;
  caps?: readonly CapabilityDef[];
}): CapabilityDef[] {
  const { query, onlyChanged, role, draft, text } = input;
  const q = query.trim().toLowerCase();
  return (input.caps ?? CAPABILITIES).filter((cap) => {
    if (onlyChanged && !differsFromDefault(role, draft, cap.key)) return false;
    if (!q) return true;
    const t = text(cap);
    return (
      t.label.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      cap.key.toLowerCase().includes(q)
    );
  });
}

export interface CapabilityGroupBlock<T extends { group: CapabilityGroup }> {
  group: CapabilityGroup;
  items: T[];
}

/** Group in CAPABILITY_GROUPS order, dropping empty groups. */
export function groupCapabilities<T extends { group: CapabilityGroup }>(
  items: readonly T[],
): CapabilityGroupBlock<T>[] {
  return CAPABILITY_GROUPS.map((group) => ({
    group,
    items: items.filter((i) => i.group === group),
  })).filter((g) => g.items.length > 0);
}

// ------------------------------------------------------------
// Confirmation summary
// ------------------------------------------------------------

export interface ChangeItem {
  key: string;
  group: CapabilityGroup;
  from: boolean;
  to: boolean;
}

export interface ChangeSummary {
  items: ChangeItem[];
  groups: CapabilityGroupBlock<ChangeItem>[];
  gained: number;
  lost: number;
  /** Menus being switched off. */
  hiddenMenus: string[];
  /** True when `roles.manage` is being removed. */
  removesRolesManage: boolean;
}

/** Everything the confirmation dialog shows, from saved vs. draft. */
export function buildChangeSummary(
  saved: ReadonlySet<string>,
  draft: ReadonlySet<string>,
): ChangeSummary {
  const items: ChangeItem[] = [];
  for (const c of CAPABILITIES) {
    const from = saved.has(c.key);
    const to = draft.has(c.key);
    if (from !== to) items.push({ key: c.key, group: c.group, from, to });
  }
  const lostItems = items.filter((i) => !i.to);
  return {
    items,
    groups: groupCapabilities(items),
    gained: items.length - lostItems.length,
    lost: lostItems.length,
    hiddenMenus: lostItems
      .filter((i) => i.key.startsWith("menu."))
      .map((i) => i.key),
    removesRolesManage: lostItems.some((i) => i.key === "roles.manage"),
  };
}

// ------------------------------------------------------------
// Reverse view (by capability)
// ------------------------------------------------------------

export interface MemberLite {
  user_id: string;
  full_name: string;
  email: string | null;
  role: AccountRole;
}

/** Roles (highest first as given) that hold `cap` in their saved state. */
export function rolesHolding(
  matrix: readonly { role: AccountRole; effective: readonly string[] }[],
  cap: string,
): AccountRole[] {
  return matrix
    .filter((r) => r.role === "owner" || r.effective.includes(cap))
    .map((r) => r.role);
}

/** Named people who hold `cap`, given the matrix and the member list. */
export function peopleHolding(
  matrix: readonly { role: AccountRole; effective: readonly string[] }[],
  members: readonly MemberLite[],
  cap: string,
): MemberLite[] {
  const roles = new Set(rolesHolding(matrix, cap));
  return members.filter((m) => roles.has(m.role));
}
