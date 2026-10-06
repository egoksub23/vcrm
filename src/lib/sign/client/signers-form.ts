// ============================================================
// Doc Sign, browser side: the signing list as the sender edits it. Pure functions over a list of rows, so
// adding, removing, reordering, what can be saved and what the server will accept are tested without a screen.
//
// A row is saved only when it is complete (the server refuses a list with a row it could never send to), so
// a half-typed row lives in the browser until it is finished.
//
// Signing order is by STEP: each row has a step number, and people who share a number form one step (they are all
// invited together, and the next step begins when every one of them has finished). The screen shows the rows in
// step order and keeps the numbers 1, 2, 3 with no gap. Without signing order the step is ignored and the order
// numbers saved are the positions in the list.
// ============================================================

import { MAX_SIGNERS, normalizePhone, type SignerDraft } from "../rules";
import type { SignChannel, SignRole, SignSignerRow, SignerKind } from "../types";

export interface SignerRow {
  /** A key for the screen only (React lists, drag and drop); never sent. */
  key: string;
  roleKey: string;
  fullName: string;
  email: string;
  /** Kept as typed; only used (and checked) for WhatsApp. */
  phone: string;
  channel: SignChannel;
  /** The step the person signs in (people who share a number sign together). Only meaningful when the document needs signing order. */
  step: number;
  /** Set when the person is a Halo user of this workspace (a countersigner): the name and email are theirs and are not typed. */
  internalUserId?: string | null;
}

/** What the server's signing-list route takes for one person. */
export interface SignerPayload {
  roleKey: string;
  kind: SignerKind;
  fullName: string;
  email: string;
  phone: string | null;
  channel: SignChannel;
  orderNo: number;
  /** Only present for a Halo user (a countersigner). */
  internalUserId?: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

let counter = 0;
export const newRowKey = (): string => `row${++counter}`;

export function kindOf(roles: readonly SignRole[], roleKey: string): SignerKind {
  return roles.find((r) => r.key === roleKey)?.kind ?? "signer";
}

export function emptyRow(roleKey = "", step = 1): SignerRow {
  return { key: newRowKey(), roleKey, fullName: "", email: "", phone: "", channel: "email", step };
}

/** The saved people as rows, in signing order (the saved order numbers are the steps). */
export function rowsFromSigners(signers: readonly SignSignerRow[]): SignerRow[] {
  return normalizeSteps(
    [...signers]
      .sort((a, b) => a.order_no - b.order_no || a.created_at.localeCompare(b.created_at))
      .map((s) => ({ key: newRowKey(), roleKey: s.role_key, fullName: s.full_name, email: s.email, phone: s.phone ?? "", channel: s.channel, step: s.order_no, ...(s.internal_user_id ? { internalUserId: s.internal_user_id } : {}) })),
  );
}

/** A starting list for a document with roles and nobody yet: one empty row for each role, each in a step of its own. */
export function rowsForRoles(roles: readonly SignRole[]): SignerRow[] {
  return roles.slice(0, MAX_SIGNERS).map((r, i) => emptyRow(r.key, i + 1));
}

// ---- steps -----------------------------------------------------------------------------------------

/** Stable order by step: people of one step stay in the order they were listed. */
export function sortedByStep(rows: readonly SignerRow[]): SignerRow[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.step - b.r.step || a.i - b.i)
    .map((x) => x.r);
}

/** The rows in step order, with the steps renumbered 1, 2, 3 and no gap (two people who shared a number still share a step). */
export function normalizeSteps(rows: readonly SignerRow[]): SignerRow[] {
  const sorted = sortedByStep(rows);
  const steps = [...new Set(sorted.map((r) => r.step))];
  return sorted.map((r) => ({ ...r, step: steps.indexOf(r.step) + 1 }));
}

/** Give a person a step number. The same number as someone else's puts them in that step. */
export function setStep(rows: readonly SignerRow[], key: string, step: number): SignerRow[] {
  const n = Math.max(1, Math.min(MAX_SIGNERS, Math.floor(Number(step)) || 1));
  return normalizeSteps(rows.map((r) => (r.key === key ? { ...r, step: n } : r)));
}

/** How many people are in each step, by step number. */
export function stepSizes(rows: readonly SignerRow[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of rows) out.set(r.step, (out.get(r.step) ?? 0) + 1);
  return out;
}

export interface StepOfRows {
  step: number;
  rows: SignerRow[];
}

/** The rows grouped by step, in signing order. */
export function groupByStep(rows: readonly SignerRow[]): StepOfRows[] {
  const out: StepOfRows[] = [];
  for (const r of sortedByStep(rows)) {
    const last = out[out.length - 1];
    if (last && last.step === r.step) last.rows.push(r);
    else out.push({ step: r.step, rows: [r] });
  }
  return out;
}

/**
 * Move a person one step earlier or later (delta -1 or 1). Out of a shared step they go into a step of their own
 * just before or after it; alone, they pass the step next to them as a whole. At the ends nothing moves.
 */
export function moveStep(rows: readonly SignerRow[], key: string, delta: -1 | 1): SignerRow[] {
  const sorted = normalizeSteps(rows);
  const me = sorted.find((r) => r.key === key);
  if (!me) return sorted;
  const last = sorted[sorted.length - 1]?.step ?? 1;
  const shared = (stepSizes(sorted).get(me.step) ?? 0) > 1;
  let to: number;
  if (shared) to = me.step + delta * 0.5;
  else if (delta < 0 && me.step > 1) to = me.step - 1.5;
  else if (delta > 0 && me.step < last) to = me.step + 1.5;
  else return sorted;
  return normalizeSteps(sorted.map((r) => (r.key === key ? { ...r, step: to } : r)));
}

/** Drop a person next to another (dragging): into a step of their own just before the other person's step if they came from below, after it if from above. */
export function dropOnRow(rows: readonly SignerRow[], fromKey: string, toKey: string): SignerRow[] {
  const sorted = normalizeSteps(rows);
  const from = sorted.find((r) => r.key === fromKey);
  const target = sorted.find((r) => r.key === toKey);
  if (!from || !target || from.step === target.step) return sorted;
  const to = from.step > target.step ? target.step - 0.5 : target.step + 0.5;
  return normalizeSteps(sorted.map((r) => (r.key === fromKey ? { ...r, step: to } : r)));
}

/**
 * The order number each row is saved with. Without signing order it is the position in the list. With it, it is the
 * rank of the row's step (1, 2, 3...), so people who share a step share a number.
 */
export function orderNumbers(rows: readonly SignerRow[], ordered: boolean): number[] {
  if (!ordered) return rows.map((_, i) => i + 1);
  const steps = [...new Set(rows.map((r) => r.step))].sort((a, b) => a - b);
  return rows.map((r) => steps.indexOf(r.step) + 1);
}

/** The role a new row should take: the first with nobody on it yet, else the first. */
export function defaultRoleFor(rows: readonly SignerRow[], roles: readonly SignRole[]): string {
  const used = new Set(rows.map((r) => r.roleKey));
  return (roles.find((r) => !used.has(r.key)) ?? roles[0])?.key ?? "";
}

export function addRow(rows: readonly SignerRow[], roles: readonly SignRole[], init: Partial<Omit<SignerRow, "key">> = {}): SignerRow[] {
  if (rows.length >= MAX_SIGNERS) return [...rows];
  // a new person starts a step of their own, after everyone
  const step = rows.reduce((m, r) => Math.max(m, r.step), 0) + 1;
  return [...rows, { ...emptyRow(init.roleKey ?? defaultRoleFor(rows, roles), step), ...init, key: newRowKey() }];
}

export const removeRow = (rows: readonly SignerRow[], key: string): SignerRow[] => rows.filter((r) => r.key !== key);

export function updateRow(rows: readonly SignerRow[], key: string, patch: Partial<Omit<SignerRow, "key">>): SignerRow[] {
  return rows.map((r) => (r.key === key ? { ...r, ...patch } : r));
}

/** Move the row at `from` to position `to` (both clamped into the list). */
export function moveRow(rows: readonly SignerRow[], from: number, to: number): SignerRow[] {
  if (from < 0 || from >= rows.length) return [...rows];
  const target = Math.max(0, Math.min(rows.length - 1, to));
  if (target === from) return [...rows];
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

export function moveRowBy(rows: readonly SignerRow[], key: string, delta: number): SignerRow[] {
  const i = rows.findIndex((r) => r.key === key);
  return i < 0 ? [...rows] : moveRow(rows, i, i + delta);
}

// ---- what is wrong with a row ----------------------------------------------------------------

export interface RowFlags {
  name: boolean;
  email: boolean;
  phone: boolean;
  role: boolean;
}

/** Which parts of a row are not acceptable: the same rules the server applies when the list is saved and sent. */
export function rowFlags(row: SignerRow, roles: readonly SignRole[]): RowFlags {
  const name = row.fullName.trim();
  const email = row.email.trim();
  return {
    name: name.length === 0 || name.length > 160,
    email: !EMAIL_RE.test(email) || email.length > 254,
    phone: row.channel === "whatsapp" && normalizePhone(row.phone) === null,
    role: row.roleKey === "" || !roles.some((r) => r.key === row.roleKey),
  };
}

export const rowIsComplete = (row: SignerRow, roles: readonly SignRole[]): boolean => {
  const f = rowFlags(row, roles);
  return !f.name && !f.email && !f.phone && !f.role;
};

/** True once the person has typed anything in the row (an untouched blank row is not an error yet). */
export const rowHasInput = (row: SignerRow): boolean => row.fullName.trim() !== "" || row.email.trim() !== "" || row.phone.trim() !== "";

/**
 * The complete rows, as the server takes them. Without signing order the order numbers are the positions among the
 * rows that are sent; with it (`ordered`) they are the rows' steps, so people who share a step share a number.
 */
export function toPayload(rows: readonly SignerRow[], roles: readonly SignRole[], ordered = false): SignerPayload[] {
  const complete = (ordered ? sortedByStep(rows) : [...rows]).filter((r) => rowIsComplete(r, roles));
  const numbers = orderNumbers(complete, ordered);
  return complete.map((r, i) => ({
    roleKey: r.roleKey,
    kind: kindOf(roles, r.roleKey),
    fullName: r.fullName.trim(),
    email: r.email.trim(),
    phone: r.channel === "whatsapp" ? (normalizePhone(r.phone) ?? null) : r.phone.trim() || null,
    channel: r.channel,
    orderNo: numbers[i],
    ...(r.internalUserId ? { internalUserId: r.internalUserId } : {}),
  }));
}

/** A string that is equal for two lists the server would store identically (to skip a save that changes nothing). */
export const payloadKey = (payload: readonly SignerPayload[]): string => JSON.stringify(payload);

/** Every row, complete or not, in the shape `sendProblems` reads. */
export function toDrafts(rows: readonly SignerRow[], roles: readonly SignRole[], ordered = false): SignerDraft[] {
  const list = ordered ? sortedByStep(rows) : [...rows];
  const numbers = orderNumbers(list, ordered);
  return list.map((r, i) => ({
    role_key: r.roleKey,
    kind: kindOf(roles, r.roleKey),
    full_name: r.fullName,
    email: r.email,
    phone: r.phone || null,
    channel: r.channel,
    order_no: numbers[i],
  }));
}

/** Rows that share an email address, with the 1-based numbers of the rows. Case and spaces are ignored. */
export function duplicateEmails(rows: readonly { email: string }[]): { email: string; positions: number[] }[] {
  const seen = new Map<string, { email: string; positions: number[] }>();
  rows.forEach((r, i) => {
    const k = r.email.trim().toLowerCase();
    if (!k) return;
    const entry = seen.get(k) ?? { email: r.email.trim(), positions: [] };
    entry.positions.push(i + 1);
    seen.set(k, entry);
  });
  return [...seen.values()].filter((e) => e.positions.length > 1);
}

// ---- Halo users ------------------------------------------------------------------------------

/** A member of the workspace, as the Halo user picker needs to know them. */
export interface HaloMember {
  user_id: string;
  full_name: string;
  email: string;
}

/** The members the sender can still choose: not already on the list as a Halo user, and matching what was typed (name or email, any case). */
export function pickableMembers(members: readonly HaloMember[], rows: readonly SignerRow[], query: string): HaloMember[] {
  const taken = new Set(rows.map((r) => r.internalUserId).filter((x): x is string => !!x));
  const q = query.trim().toLowerCase();
  return members.filter((m) => !taken.has(m.user_id) && (q === "" || m.full_name.toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q)));
}

/** What choosing a member does to a row: their name and email, and the link to them. A phone number typed before is dropped with the channel back to email (a Halo user is reached by email). */
export function asHaloUser(member: HaloMember): Partial<Omit<SignerRow, "key">> {
  return { fullName: member.full_name.trim() || member.email, email: member.email.trim(), phone: "", channel: "email", internalUserId: member.user_id };
}

/** Un-choose the Halo user: the row keeps the name and email shown, as plain typed values the sender can now change. */
export const asOutsidePerson: Partial<Omit<SignerRow, "key">> = { internalUserId: null };

/** Roles that have fields to complete but nobody on them yet (by key). */
export function rolesWithoutPeople(rows: readonly SignerRow[], roles: readonly SignRole[]): SignRole[] {
  const used = new Set(rows.map((r) => r.roleKey));
  return roles.filter((r) => !used.has(r.key));
}

export interface ReviewLine {
  /** 1-based position in the list. */
  position: number;
  /** The step the person signs in (1, 2, 3; the same for people who sign together); equal to the position without signing order. */
  step: number;
  name: string;
  email: string;
  phone: string;
  channel: SignChannel;
  roleKey: string;
  roleLabel: string;
  kind: SignerKind;
}

/** The people who will be invited, in order, for the review step's plain summary. */
export function reviewLines(rows: readonly SignerRow[], roles: readonly SignRole[], ordered = false): ReviewLine[] {
  const list = ordered ? sortedByStep(rows) : [...rows];
  const numbers = orderNumbers(list, ordered);
  return list.map((r, i) => ({
    position: i + 1,
    step: numbers[i],
    name: r.fullName.trim(),
    email: r.email.trim(),
    phone: r.phone.trim(),
    channel: r.channel,
    roleKey: r.roleKey,
    roleLabel: roles.find((x) => x.key === r.roleKey)?.label ?? r.roleKey,
    kind: kindOf(roles, r.roleKey),
  }));
}
