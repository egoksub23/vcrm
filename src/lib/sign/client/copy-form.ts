// ============================================================
// Doc Sign, browser side: the people who RECEIVE A COPY of a document on its own, as the sender edits them (migration 175). Pure functions over
// a small list, kept apart from the signing list (`SignerRow`) on purpose: a person who receives a copy is not a signer, so nothing that reads
// the signing list (the payload, the problems, the review's order) ever sees them.
//
// A copy person is a name and an email address. They are saved only when complete, at most 10, each address once, and never an address that
// also signs (they get the signed copy anyway). What is left out of the save is named on screen (`copyNotices`), so the sender is never
// left thinking someone is saved who is not.
// ============================================================

import { MAX_SIGNERS } from "../rules";
import { MAX_COPY_RECIPIENTS } from "../envelopes";
import type { SignCopyRecipientRow, SignRole } from "../types";
import { addRow, removeRow, type SignerRow } from "./signers-form";

export interface CopyRow {
  /** A key for the screen only (React lists); never sent. */
  key: string;
  fullName: string;
  email: string;
}

/** What the copies route takes for one person. */
export interface CopyPayload {
  fullName: string;
  email: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

let counter = 0;
export const newCopyRowKey = (): string => `copy${++counter}`;

export function emptyCopy(init: Partial<Omit<CopyRow, "key">> = {}): CopyRow {
  return { key: newCopyRowKey(), fullName: "", email: "", ...init };
}

/** The saved people as rows, in the order they were added. */
export function copiesFromRecords(records: readonly Pick<SignCopyRecipientRow, "full_name" | "email">[] = []): CopyRow[] {
  return records.map((c) => emptyCopy({ fullName: c.full_name, email: c.email }));
}

export const canAddCopy = (copies: readonly CopyRow[]): boolean => copies.length < MAX_COPY_RECIPIENTS;

export function addCopy(copies: readonly CopyRow[], init: Partial<Omit<CopyRow, "key">> = {}): CopyRow[] {
  if (!canAddCopy(copies)) return [...copies];
  return [...copies, emptyCopy(init)];
}

export const removeCopy = (copies: readonly CopyRow[], key: string): CopyRow[] => copies.filter((c) => c.key !== key);

export function updateCopy(copies: readonly CopyRow[], key: string, patch: Partial<Omit<CopyRow, "key">>): CopyRow[] {
  return copies.map((c) => (c.key === key ? { ...c, ...patch } : c));
}

// ---- what is wrong with a person ------------------------------------------------------------------

export interface CopyFlags {
  name: boolean;
  email: boolean;
}

/** Which parts are not acceptable: the same rules the server applies when the list is saved. */
export function copyFlags(c: Pick<CopyRow, "fullName" | "email">): CopyFlags {
  const name = c.fullName.trim();
  const email = c.email.trim();
  return { name: name.length === 0 || name.length > 160, email: !EMAIL_RE.test(email) || email.length > 254 };
}

export const copyIsComplete = (c: Pick<CopyRow, "fullName" | "email">): boolean => {
  const f = copyFlags(c);
  return !f.name && !f.email;
};

/** True once the person has typed anything (an untouched blank person is not an error yet). */
export const copyHasInput = (c: Pick<CopyRow, "fullName" | "email">): boolean => c.fullName.trim() !== "" || c.email.trim() !== "";

const lower = (email: string): string => email.trim().toLowerCase();

export type CopyNoticeKind = "duplicate" | "signer";

export interface CopyNotice {
  /** 0-based position in the copy list. */
  index: number;
  kind: CopyNoticeKind;
  /** The address, as typed. */
  email: string;
  /** For `duplicate`: the 1-based positions in the copy list that share the address (the first is kept, the others are left out). */
  positions: number[];
}

/**
 * Lines about the copy people that are not a missing value, in the style of `duplicateEmails`: an address listed twice (only the first is saved)
 * and an address that also signs (that person gets the signed copy anyway, so the entry is left out). Case and spaces are ignored.
 */
export function copyNotices(copies: readonly CopyRow[], signerEmails: readonly string[]): CopyNotice[] {
  const signing = new Set(signerEmails.map(lower).filter(Boolean));
  const byEmail = new Map<string, number[]>();
  copies.forEach((c, i) => {
    const k = lower(c.email);
    if (k) byEmail.set(k, [...(byEmail.get(k) ?? []), i + 1]);
  });
  const out: CopyNotice[] = [];
  copies.forEach((c, i) => {
    const k = lower(c.email);
    if (!k) return;
    const positions = byEmail.get(k) ?? [];
    if (signing.has(k)) out.push({ index: i, kind: "signer", email: c.email.trim(), positions: [] });
    else if (positions.length > 1) out.push({ index: i, kind: "duplicate", email: c.email.trim(), positions });
  });
  return out;
}

/**
 * The complete people, as the server takes them: a name (at most 160 characters) and a valid address (at most 254), each address once (the
 * first one listed), never an address that signs, and at most 10.
 */
export function copyPayload(copies: readonly CopyRow[], signerEmails: readonly string[] = []): CopyPayload[] {
  const signing = new Set(signerEmails.map(lower).filter(Boolean));
  const seen = new Set<string>();
  const out: CopyPayload[] = [];
  for (const c of copies) {
    if (!copyIsComplete(c)) continue;
    const k = lower(c.email);
    if (signing.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({ fullName: c.fullName.trim(), email: c.email.trim() });
    if (out.length >= MAX_COPY_RECIPIENTS) break;
  }
  return out;
}

/** A string that is equal for two lists the server would store identically (to skip a save that changes nothing). */
export const copyKey = (payload: readonly CopyPayload[]): string => JSON.stringify(payload.map((p) => [p.fullName, p.email]));

// ---- choosing a contact -------------------------------------------------------------------------------

/** The part of a contact that fills a person. */
export interface ContactFill {
  name: string | null;
  email: string | null;
  phone?: string | null;
}

/**
 * What choosing a contact does to a person: their name and email (the email stays editable). A contact with no email leaves the typed email
 * alone; one with no name leaves the typed name.
 */
export function fillFromContact(c: ContactFill, current: { fullName: string; email: string }): { fullName: string; email: string } {
  return { fullName: c.name?.trim() || current.fullName, email: c.email?.trim() || current.email };
}

// ---- changing a person's type ---------------------------------------------------------------------------

export interface TypedLists {
  rows: SignerRow[];
  copies: CopyRow[];
}

/** A person who must sign now only receives a copy: the row leaves the signing list and goes, with name and email, to the copy list. Nothing moves when the copy list is full. */
export function signerToCopy(rows: readonly SignerRow[], copies: readonly CopyRow[], rowKey: string): TypedLists {
  const row = rows.find((r) => r.key === rowKey);
  if (!row || !canAddCopy(copies)) return { rows: [...rows], copies: [...copies] };
  return { rows: removeRow(rows, rowKey), copies: addCopy(copies, { fullName: row.fullName, email: row.email }) };
}

/** A person who received a copy now must sign: they join the signing list (a step of their own, the next free role). Nothing moves when the signing list is full. */
export function copyToSigner(rows: readonly SignerRow[], copies: readonly CopyRow[], roles: readonly SignRole[], copyRowKey: string): TypedLists {
  const copy = copies.find((c) => c.key === copyRowKey);
  if (!copy || rows.length >= MAX_SIGNERS) return { rows: [...rows], copies: [...copies] };
  return { rows: addRow(rows, roles, { fullName: copy.fullName, email: copy.email }), copies: removeCopy(copies, copyRowKey) };
}
