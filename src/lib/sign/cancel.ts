// ============================================================
// Cancelling a COMPLETED document (migration 181): the rules both sides share. Pure and free of I/O, so the dialog, the routes and the services say
// the same thing, and it is safe to import from the browser.
//
// A completed document is a sealed record. Cancelling does not touch it: `status` stays "completed", the signed file, the certificate, the answers and
// the audit chain are as they were. It adds a stamp (who, when, why) that says the document is no longer in force. A document collection is cancelled as a
// unit, every document of it together. There is no undo: a fresh document is sent instead.
//
// WHO may cancel: the person who made the document (its `created_by`), and the workspace's admins and owners, who must also be able to see it (a private
// document, migration 176, is judged as ever). This is a check of its own and not `sign.void`: voiding stops a document that is still out; this
// withdraws a signed record, and the people who may do it are the ones answerable for the document. No capability was added, so Roles & permissions
// is unchanged. The server enforces it (service/cancel.ts); the screens only hide the button.
// ============================================================

/** A reason is required: at least this many characters (not counting spaces at either end)... */
export const CANCEL_REASON_MIN = 3;
/** ...and at most this many (the database holds the same limits). */
export const CANCEL_REASON_MAX = 500;

/** How many characters a text has, the way the database counts them (a character outside the basic plane is one). */
export const characterCount = (s: string): number => Array.from(s).length;

/** What the person typed, trimmed. Anything that is not text is empty. */
export const cleanCancelReason = (raw: unknown): string => (typeof raw === "string" ? raw.trim() : "");

export type CancelReasonProblem = "required" | "short" | "long";

/** What is wrong with a reason (already trimmed), or null when it will do. */
export function cancelReasonProblem(reason: string): CancelReasonProblem | null {
  const n = characterCount(reason);
  if (n === 0) return "required";
  if (n < CANCEL_REASON_MIN) return "short";
  if (n > CANCEL_REASON_MAX) return "long";
  return null;
}

/** The facts of a document or collection that decide whether it is cancelled. */
export interface CancelFacts {
  status?: string | null;
  cancelled_at?: string | null;
}

/** A completed document (or collection) that was cancelled afterwards. A cancelled one is still "completed" everywhere else. */
export const isCancelled = (row: CancelFacts | null | undefined): boolean => !!row && row.status === "completed" && !!row.cancelled_at;

/** Whether a document or collection can still be cancelled: it is completed and has not been. */
export const isCancellable = (row: CancelFacts | null | undefined): boolean => !!row && row.status === "completed" && !row.cancelled_at;

/** Who is looking: the signed-in person and whether they are an admin or owner of the workspace. */
export interface CancelViewer {
  userId: string | null | undefined;
  isAdmin: boolean;
}

/**
 * Whether the screen offers "Cancel document" to this person for this row: it is completed and not cancelled yet, and the person made it or is an
 * admin or owner. (The server asks again, and also whether the person can see the document.)
 */
export function canCancelRow(row: CancelFacts & { created_by?: string | null }, who: CancelViewer): boolean {
  if (!isCancellable(row)) return false;
  if (who.isAdmin) return true;
  return !!who.userId && !!row.created_by && row.created_by === who.userId;
}

/** The body of the cancel request. `notify`: email the signers, the people who receive a copy and the sender (off unless the person ticks it). */
export interface CancelRequest {
  reason: string;
  notify: boolean;
}

/** What a cancel answers: how much was cancelled and how the notice went. */
export interface CancelResult {
  cancelled: true;
  /** `document` for a document on its own, `collection` for a document collection (and every document in it). */
  scope: "document" | "collection";
  /** How many documents were cancelled (more than one only for a collection). */
  documents: number;
  cancelledAt: string;
  /** The notice: null when it was not asked for; otherwise how many people were emailed and how many could not be. */
  notice: { sent: number; failed: number } | null;
}
