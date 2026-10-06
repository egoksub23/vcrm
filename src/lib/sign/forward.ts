// ============================================================
// Doc Sign: the rules of forwarding and of steps, in one place used by the browser and the server. Pure: no
// I/O, no framework.
//
// A signer may hand their whole turn, or one part of a form, to someone else (F-95). A whole turn replaces the
// person on their position (the same row); a part goes to a DELEGATE: a filler of the same role, restricted to
// the parts they were given (`part_keys`), who completes them and never signs. The database decides every
// forward under a lock (migration 166); the functions here are the same rules for the screens that show them,
// for the services that need to know who answers what, and for naming people in the history.
//
// Signers who share an order number form one STEP (F-68). A delegate shares the step of the person who gave
// them the part and is never a person of the step of their own.
// ============================================================

import type { FormDefinition, FormPart } from "./forms/types";
import type { SignSignerRow } from "./types";

/** A turn or a part may be handed on this many times per signer position, so a document cannot be passed around without end. */
export const MAX_FORWARDS = 2;
/** The longest note that can go with a forward. */
export const FORWARD_NOTE_MAX = 500;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** What the rules below need to know about a signer. */
export type SignerLike = Pick<SignSignerRow, "id" | "role_key" | "order_no"> & Partial<Pick<SignSignerRow, "part_keys" | "delegated_by" | "status" | "full_name" | "email" | "kind" | "created_at" | "forward_count">>;

/** Anything that may carry `part_keys` (a signer row, or a smaller shape of one). */
export interface HasParts {
  part_keys?: string[] | null;
}

/** A delegate: someone who was handed parts of another signer's form. */
export const isDelegate = (s: HasParts): boolean => Array.isArray(s.part_keys) && s.part_keys.length > 0;

/** An address as the audit trail shows it: a***@example.com (the same as the database writes). */
export function maskEmail(email: string | null | undefined): string {
  const e = email ?? "";
  const at = e.indexOf("@");
  return at > 0 ? `${e.slice(0, 1)}***${e.slice(at)}` : "***";
}

// ---- who owns a part -------------------------------------------------------------------------------------

/** The parts a delegate holds, by key (a part held by a delegate is not answered by anyone else). */
export function heldParts(signers: readonly HasParts[]): Set<string> {
  const out = new Set<string>();
  for (const s of signers) if (isDelegate(s)) for (const k of s.part_keys ?? []) out.add(k);
  return out;
}

/** May this person's answers count for this part? A delegate for the parts they hold; anyone else of the role for the parts nobody holds. */
export function mayAnswerPart(signer: { role_key: string } & HasParts, part: Pick<FormPart, "key" | "role">, held: ReadonlySet<string>): boolean {
  if (signer.role_key !== part.role) return false;
  if (isDelegate(signer)) return (signer.part_keys ?? []).includes(part.key);
  return !held.has(part.key);
}

/**
 * The parts a person sees on their page: the parts of their role, and for a delegate only the ones they hold.
 * A signer keeps seeing a part they handed over (it shows who holds it), but does not answer it.
 */
export function partsShown(form: FormDefinition, signer: { role_key: string } & HasParts): FormPart[] {
  const own = form.parts.filter((p) => p.role === signer.role_key);
  return isDelegate(signer) ? own.filter((p) => (signer.part_keys ?? []).includes(p.key)) : own;
}

/** The parts this person answers themselves: what they see, less what they handed over. */
export function partsAnswered(form: FormDefinition, signer: { role_key: string } & HasParts, signers: readonly HasParts[]): FormPart[] {
  const held = heldParts(signers);
  return partsShown(form, signer).filter((p) => mayAnswerPart(signer, p, held));
}

export interface Delegation {
  part: string;
  /** The delegate's row. */
  signerId: string;
  name: string;
  /** The delegate has completed their part. */
  done: boolean;
}

/** The parts this signer has handed to someone, and where each stands. */
export function delegationsOf(signers: readonly SignerLike[], signerId: string): Delegation[] {
  const out: Delegation[] = [];
  for (const s of signers) {
    if (s.delegated_by !== signerId || !isDelegate(s)) continue;
    for (const part of s.part_keys ?? []) out.push({ part, signerId: s.id, name: s.full_name ?? "", done: s.status === "signed" });
  }
  return out;
}

/** The delegates of this signer who have not completed their part (the signer cannot finish while any is open). */
export const openDelegations = (signers: readonly SignerLike[], signerId: string): Delegation[] => delegationsOf(signers, signerId).filter((d) => !d.done);

// ---- what a forward may be ---------------------------------------------------------------------------------

export type ForwardProblem = "forward_details" | "forward_same_person" | "forward_already_signer" | "forward_limit";

/**
 * Is this a person the signer may forward to? The rules the database applies (migration 166), so a dialog can
 * say so before anything is sent. `others` are the other people on the document. A person already on it for
 * the same role cannot be the recipient, and neither can anyone already on it when the document needs signing order.
 */
export function forwardProblem(
  input: { name: string; email: string },
  who: { email: string; role_key: string; forwardCount: number },
  doc: { ordered: boolean },
  others: readonly Pick<SignerLike, "id" | "email" | "role_key">[],
  opts: { except?: string } = {},
): ForwardProblem | null {
  const name = input.name.trim();
  const email = input.email.trim();
  if (!name || name.length > 160 || !EMAIL_RE.test(email) || email.length > 254) return "forward_details";
  if (who.forwardCount >= MAX_FORWARDS) return "forward_limit";
  if (email.toLowerCase() === who.email.trim().toLowerCase()) return "forward_same_person";
  const clash = others.some((o) => o.id !== opts.except && (o.email ?? "").trim().toLowerCase() === email.toLowerCase() && (o.role_key === who.role_key || doc.ordered));
  return clash ? "forward_already_signer" : null;
}

/** How many more times this position may forward. */
export const forwardsLeft = (signer: Pick<SignerLike, "forward_count">): number => Math.max(0, MAX_FORWARDS - (signer.forward_count ?? 0));

// ---- steps -----------------------------------------------------------------------------------------------

export interface StepGroup<T> {
  /** 1, 2, 3 in signing order, whatever the order numbers were. */
  step: number;
  orderNo: number;
  people: T[];
}

/** The people of a document grouped into steps, in signing order. A delegate is not a person of a step. */
export function stepGroups<T extends { order_no: number; created_at?: string } & HasParts>(signers: readonly T[]): StepGroup<T>[] {
  const people = signers.filter((s) => !isDelegate(s));
  const byOrder = new Map<number, T[]>();
  for (const s of people) byOrder.set(s.order_no, [...(byOrder.get(s.order_no) ?? []), s]);
  return [...byOrder.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([orderNo, list], i) => ({ step: i + 1, orderNo, people: [...list].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")) }));
}

// ---- names in the history ---------------------------------------------------------------------------------

export interface HistoryEvent {
  type: string;
  signer_id: string | null;
  created_at: string;
  detail?: Record<string, unknown> | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Who a person was when something happened. Forwarding a turn replaces the name on a position, so an event the
 * forwarder caused must keep the forwarder's name: the first `forwarded` event of the position at or after the
 * time of the event names who held it until then. A delegate whose part was taken back no longer has a row; the
 * event that handed them the part names them. Null when nothing is known.
 */
export function nameResolver(signers: readonly { id: string; full_name: string }[], events: readonly HistoryEvent[]): (signerId: string | null, at: string) => string | null {
  const current = new Map(signers.map((s) => [s.id, s.full_name]));
  const forwards = new Map<string, { at: string; from: string }[]>();
  const gone = new Map<string, string>();
  for (const e of events) {
    const d = e.detail ?? {};
    if (e.type === "forwarded" && e.signer_id) {
      const from = str(d.from_name);
      if (from) forwards.set(e.signer_id, [...(forwards.get(e.signer_id) ?? []), { at: e.created_at, from }]);
    } else if (e.type === "part_forwarded") {
      const id = str(d.delegate);
      const to = str(d.to_name);
      if (id && to) gone.set(id, to);
    }
  }
  for (const list of forwards.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  return (signerId, at) => {
    if (!signerId) return null;
    const later = (forwards.get(signerId) ?? []).find((f) => f.at >= at);
    if (later) return later.from;
    return current.get(signerId) ?? gone.get(signerId) ?? null;
  };
}

/** The names a finished person's page waits for: everyone invited who has not finished. */
export function waitingNames(others: readonly { name: string; status: string; kind?: string }[]): string[] {
  return others.filter((o) => o.status === "sent" || o.status === "viewed").map((o) => o.name);
}
