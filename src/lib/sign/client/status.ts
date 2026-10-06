// ============================================================
// Doc Sign, browser side: how a document's or a signer's status is worded and coloured, in one place.
//
// The words live in the `Sign.send` message namespace under `status.*`. A screen in any other
// namespace reads them with `useTranslations(SIGN_STATUS_NAMESPACE)` and `t(documentStatusKey(s))`.
// Colour is never the only signal: every badge carries the word. The classes are soft tints that
// read in light and dark, the same convention as the ticket and incident badges.
// ============================================================

import type { DocumentStatus, SignerKind, SignerStatus } from "../types";

/** The namespace the keys below are relative to. */
export const SIGN_STATUS_NAMESPACE = "Sign.send";

const DOCUMENT_STATUS_SET: ReadonlySet<string> = new Set<DocumentStatus>(["draft", "sent", "in_progress", "sealing", "completed", "declined", "expired", "voided", "failed"]);
const SIGNER_STATUS_SET: ReadonlySet<string> = new Set<SignerStatus>(["pending", "sent", "viewed", "signed", "declined"]);

/** The message key (relative to `Sign.send`) for a document status. An unknown status reads as "unknown". */
export function documentStatusKey(status: string): string {
  return DOCUMENT_STATUS_SET.has(status) ? `status.document.${status}` : "status.unknown";
}

/**
 * The message key for a signer status. A filler (completes fields, does not sign) who has finished
 * reads "Filled in" instead of "Signed".
 */
export function signerStatusKey(status: string, kind: SignerKind = "signer"): string {
  if (!SIGNER_STATUS_SET.has(status)) return "status.unknown";
  if (status === "signed" && kind === "filler") return "status.signer.filled";
  return `status.signer.${status}`;
}

const MUTED = "bg-muted text-muted-foreground";

export const DOCUMENT_BADGE: Record<DocumentStatus, string> = {
  draft: MUTED,
  sent: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  in_progress: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  sealing: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  declined: "bg-red-500/15 text-red-700 dark:text-red-300",
  expired: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  voided: MUTED,
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
};

export const SIGNER_BADGE: Record<SignerStatus, string> = {
  pending: MUTED,
  sent: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  viewed: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  signed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  declined: "bg-red-500/15 text-red-700 dark:text-red-300",
};

export function documentBadgeClass(status: string): string {
  return DOCUMENT_STATUS_SET.has(status) ? DOCUMENT_BADGE[status as DocumentStatus] : MUTED;
}

export function signerBadgeClass(status: string): string {
  return SIGNER_STATUS_SET.has(status) ? SIGNER_BADGE[status as SignerStatus] : MUTED;
}

// ---- who is waiting ------------------------------------------------------------------------

export interface WaitingSignerLike {
  full_name: string;
  status: string;
  order_no: number;
}

/**
 * The people a document is waiting on: only while it is open, and only those who have been invited
 * and have not finished. With signing order the next people are not invited yet, so they are not
 * "waiting on" until their turn. Sorted by order.
 */
export function waitingOn<T extends WaitingSignerLike>(documentStatus: string, signers: readonly T[]): T[] {
  if (documentStatus !== "sent" && documentStatus !== "in_progress") return [];
  return signers.filter((s) => s.status === "sent" || s.status === "viewed").sort((a, b) => a.order_no - b.order_no);
}

/**
 * Inputs for the "Waiting on" text: the first `max` names and how many more there are, so the screen
 * can word "Ali, Siti and 2 more" in its own language. `names` is empty when nobody is waited on.
 */
export function waitingSummary(documentStatus: string, signers: readonly WaitingSignerLike[], max = 2): { names: string[]; more: number } {
  const waiting = waitingOn(documentStatus, signers);
  return { names: waiting.slice(0, max).map((s) => s.full_name), more: Math.max(0, waiting.length - max) };
}

/** How many of the people on a document have finished (signed, or filled in), and how many there are. */
export function signerProgress(signers: readonly { status: string }[]): { done: number; total: number } {
  return { done: signers.filter((s) => s.status === "signed").length, total: signers.length };
}
