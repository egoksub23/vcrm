// ============================================================
// Doc Sign envelopes (migration 171): the limits, and how an envelope's status follows from its documents. Pure.
//
// `deriveEnvelopeStatus` is the same rule as the database's `sign_envelope_derive`, so a screen that has the documents in hand
// can say what the envelope is without another read, and a test can hold the two together. The words are the documents'.
// ============================================================

import type { DocumentStatus } from "../types";

/** An envelope groups 2 to 6 documents. */
export const ENVELOPE_MIN_DOCUMENTS = 2;
export const ENVELOPE_MAX_DOCUMENTS = 6;
/** Together, the documents of one envelope may not run to more pages or bytes than this (the frozen files, when it is sent). */
export const ENVELOPE_MAX_PAGES = 300;
export const ENVELOPE_MAX_BYTES = 50 * 1024 * 1024;
/** The completion message attaches signed copies up to this many bytes in all; the rest are named and left to the person's link. */
export const ENVELOPE_ATTACH_BYTES = 20 * 1024 * 1024;

/** The status of an envelope, from the statuses of its documents (an envelope with none is a draft). */
export function deriveEnvelopeStatus(statuses: readonly DocumentStatus[]): DocumentStatus {
  if (statuses.length === 0 || statuses.includes("draft")) return "draft";
  if (statuses.every((s) => s === "voided")) return "voided";
  if (statuses.every((s) => s === "completed")) return "completed";
  if (statuses.includes("declined")) return "declined";
  if (statuses.includes("expired")) return "expired";
  if (statuses.includes("voided")) return "voided";
  if (statuses.includes("failed")) return "failed";
  if (statuses.every((s) => s === "sealing" || s === "completed")) return "sealing";
  if (statuses.some((s) => s === "in_progress" || s === "sealing" || s === "completed")) return "in_progress";
  return "sent";
}

/** A document that every one of its people has signed: sealing, being checked again, or sealed. The sender can no longer void the envelope once one is. */
export const FULLY_SIGNED: readonly DocumentStatus[] = ["sealing", "completed", "failed"];

/** Can the sender cancel the envelope: it is out, something is still open, and no document is fully signed. */
export function canVoidEnvelope(statuses: readonly DocumentStatus[]): { ok: boolean; reason?: "not_sent" | "already_final" | "partly_completed" } {
  if (statuses.length === 0 || statuses.includes("draft")) return { ok: false, reason: "not_sent" };
  if (!statuses.some((s) => s === "sent" || s === "in_progress")) return { ok: false, reason: "already_final" };
  if (statuses.some((s) => FULLY_SIGNED.includes(s))) return { ok: false, reason: "partly_completed" };
  return { ok: true };
}

/** How many of the documents are completed (signed by everyone and sealed), of how many. */
export function documentsDone(statuses: readonly DocumentStatus[]): { done: number; total: number } {
  return { done: statuses.filter((s) => s === "completed").length, total: statuses.length };
}
