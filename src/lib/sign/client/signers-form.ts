// ============================================================
// Doc Sign, browser side: the signing list as the sender edits it. Pure functions over a list of rows, so
// adding, removing, reordering, what can be saved and what the server will accept are tested without a screen.
//
// A row is saved only when it is complete (the server refuses a list with a row it could never send to), so
// a half-typed row lives in the browser until it is finished. The order of the rows IS the signing order:
// numbers are positions 1..n, so two people can never share a number from this screen.
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
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

let counter = 0;
export const newRowKey = (): string => `row${++counter}`;

export function kindOf(roles: readonly SignRole[], roleKey: string): SignerKind {
  return roles.find((r) => r.key === roleKey)?.kind ?? "signer";
}

export function emptyRow(roleKey = ""): SignerRow {
  return { key: newRowKey(), roleKey, fullName: "", email: "", phone: "", channel: "email" };
}

/** The saved people as rows, in signing order. */
export function rowsFromSigners(signers: readonly SignSignerRow[]): SignerRow[] {
  return [...signers]
    .sort((a, b) => a.order_no - b.order_no || a.created_at.localeCompare(b.created_at))
    .map((s) => ({ key: newRowKey(), roleKey: s.role_key, fullName: s.full_name, email: s.email, phone: s.phone ?? "", channel: s.channel }));
}

/** A starting list for a document with roles and nobody yet: one empty row for each role. */
export function rowsForRoles(roles: readonly SignRole[]): SignerRow[] {
  return roles.slice(0, MAX_SIGNERS).map((r) => emptyRow(r.key));
}

/** The role a new row should take: the first with nobody on it yet, else the first. */
export function defaultRoleFor(rows: readonly SignerRow[], roles: readonly SignRole[]): string {
  const used = new Set(rows.map((r) => r.roleKey));
  return (roles.find((r) => !used.has(r.key)) ?? roles[0])?.key ?? "";
}

export function addRow(rows: readonly SignerRow[], roles: readonly SignRole[], init: Partial<Omit<SignerRow, "key">> = {}): SignerRow[] {
  if (rows.length >= MAX_SIGNERS) return [...rows];
  return [...rows, { ...emptyRow(init.roleKey ?? defaultRoleFor(rows, roles)), ...init, key: newRowKey() }];
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

/** The complete rows, as the server takes them. Positions are counted among the rows that are sent. */
export function toPayload(rows: readonly SignerRow[], roles: readonly SignRole[]): SignerPayload[] {
  return rows
    .filter((r) => rowIsComplete(r, roles))
    .map((r, i) => ({
      roleKey: r.roleKey,
      kind: kindOf(roles, r.roleKey),
      fullName: r.fullName.trim(),
      email: r.email.trim(),
      phone: r.channel === "whatsapp" ? (normalizePhone(r.phone) ?? null) : r.phone.trim() || null,
      channel: r.channel,
      orderNo: i + 1,
    }));
}

/** A string that is equal for two lists the server would store identically (to skip a save that changes nothing). */
export const payloadKey = (payload: readonly SignerPayload[]): string => JSON.stringify(payload);

/** Every row, complete or not, in the shape `sendProblems` reads. */
export function toDrafts(rows: readonly SignerRow[], roles: readonly SignRole[]): SignerDraft[] {
  return rows.map((r, i) => ({
    role_key: r.roleKey,
    kind: kindOf(roles, r.roleKey),
    full_name: r.fullName,
    email: r.email,
    phone: r.phone || null,
    channel: r.channel,
    order_no: i + 1,
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

/** Roles that have fields to complete but nobody on them yet (by key). */
export function rolesWithoutPeople(rows: readonly SignerRow[], roles: readonly SignRole[]): SignRole[] {
  const used = new Set(rows.map((r) => r.roleKey));
  return roles.filter((r) => !used.has(r.key));
}

export interface ReviewLine {
  /** 1-based position in the list. */
  position: number;
  name: string;
  email: string;
  phone: string;
  channel: SignChannel;
  roleKey: string;
  roleLabel: string;
  kind: SignerKind;
}

/** The people who will be invited, in order, for the review step's plain summary. */
export function reviewLines(rows: readonly SignerRow[], roles: readonly SignRole[]): ReviewLine[] {
  return rows.map((r, i) => ({
    position: i + 1,
    name: r.fullName.trim(),
    email: r.email.trim(),
    phone: r.phone.trim(),
    channel: r.channel,
    roleKey: r.roleKey,
    roleLabel: roles.find((x) => x.key === r.roleKey)?.label ?? r.roleKey,
    kind: kindOf(roles, r.roleKey),
  }));
}
