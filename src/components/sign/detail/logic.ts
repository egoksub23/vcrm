// ============================================================
// Doc Sign, the detail of a document that was sent: the decisions the screen makes, kept pure so they can
// be tested. What the status banner says, which actions each state and capability allow, who has a message
// that did not arrive, and which failure code reads as which sentence.
// ============================================================

import { waitingSummary } from "@/lib/sign/client/status";
import { REMIND_GAP_MS as REMIND_GAP } from "@/lib/sign/defaults";
import type { DocumentStatus, SignSignerRow } from "@/lib/sign/types";

/** How often the screen asks again while the document can still change, in milliseconds. */
export const POLL_MS = 10_000;

/** A reminder to the same person is held back for this long (features F-25); the API keeps the same rule. */
export const REMIND_GAP_MS = REMIND_GAP;

const POLLED: ReadonlySet<string> = new Set<DocumentStatus>(["sent", "in_progress", "sealing"]);

/** Documents that can still change under our feet: someone may sign, or the sealing job may finish. */
export function shouldPoll(status: string): boolean {
  return POLLED.has(status);
}

export interface DetailCaps {
  send: boolean;
  void: boolean;
  /** Sees technical detail such as why a sealing attempt failed. */
  settings: boolean;
}

// ---- the banner ----------------------------------------------------------------------------

/** `form`: a form without a signature (migration 169): the banner says "submitted" and "record", never "signed". */
export type Banner =
  | { kind: "draft" }
  | { kind: "waiting"; names: string[]; more: number; done: number; total: number; form?: boolean }
  | { kind: "sealing"; form?: boolean }
  | { kind: "completed"; at: string | null; retainUntil?: string; form?: boolean }
  | { kind: "declined"; by: string | null; reason: string | null; form?: boolean }
  | { kind: "expired"; at: string | null }
  | { kind: "voided"; reason: string | null }
  | { kind: "failed"; error: string | null };

export interface BannerDoc {
  status: string;
  completed_at: string | null;
  expires_at: string | null;
  void_reason: string | null;
  seal_error: string | null;
  /** The date a signed document is kept until (set when it was sealed). */
  retain_until?: string | null;
  /** Migration 169: `form` for a form without a signature. */
  mode?: string | null;
}

export type BannerSigner = Pick<SignSignerRow, "full_name" | "status" | "order_no" | "declined_at" | "decline_reason"> & Partial<Pick<SignSignerRow, "part_keys">>;

/** What is happening to the document, as data; the screen words it in the reader's language. */
export function bannerFor(doc: BannerDoc, signers: readonly BannerSigner[], caps: Pick<DetailCaps, "settings">): Banner {
  const form = doc.mode === "form" ? { form: true as const } : {};
  switch (doc.status) {
    case "draft":
      return { kind: "draft" };
    case "sent":
    case "in_progress": {
      const w = waitingSummary(doc.status, signers, 2);
      // a person who was handed one part of someone's form is part of that person's turn, not another signer
      const people = signers.filter((s) => !(s.part_keys && s.part_keys.length > 0));
      return { kind: "waiting", names: w.names, more: w.more, done: people.filter((s) => s.status === "signed").length, total: people.length, ...form };
    }
    case "sealing":
      return { kind: "sealing", ...form };
    case "completed":
      return { kind: "completed", at: doc.completed_at, ...(doc.retain_until ? { retainUntil: doc.retain_until } : {}), ...form };
    case "declined": {
      const who = signers
        .filter((s) => s.status === "declined")
        .sort((a, b) => (a.declined_at ?? "").localeCompare(b.declined_at ?? ""))[0];
      return { kind: "declined", by: who?.full_name ?? null, reason: who?.decline_reason?.trim() || null, ...form };
    }
    case "expired":
      return { kind: "expired", at: doc.expires_at };
    case "voided":
      return { kind: "voided", reason: doc.void_reason?.trim() || null };
    case "failed":
      // The reason is a technical note for whoever runs the workspace: other people only read that we are looking into it.
      return { kind: "failed", error: caps.settings ? doc.seal_error?.trim() || null : null };
    default:
      return { kind: "draft" };
  }
}

/**
 * Where a signed document stands against its retention date: `kept` (it cannot be deleted by anyone yet) or `ended`
 * (the date has passed). A document with no date has none to show.
 */
export function retentionState(retainUntil: string | null | undefined, now: Date): "kept" | "ended" | null {
  if (!retainUntil) return null;
  const end = new Date(retainUntil).getTime();
  if (Number.isNaN(end)) return null;
  return end > now.getTime() ? "kept" : "ended";
}

export type BannerTone = "info" | "success" | "danger" | "warning" | "muted";

export function bannerTone(b: Banner): BannerTone {
  switch (b.kind) {
    case "completed":
      return "success";
    case "declined":
    case "failed":
      return "danger";
    case "expired":
    case "sealing":
      return "warning";
    case "voided":
    case "draft":
      return "muted";
    default:
      return "info";
  }
}

// ---- actions on the document ---------------------------------------------------------------

export interface ActionDoc {
  status: string;
  base_path: string | null;
  final_path: string | null;
  original_path: string | null;
  /** Migration 169: `form` for a form without a signature. Its base file is only a stand-in: nobody reads it, and only the sealed record is viewed. */
  mode?: string | null;
}

export interface DocumentActions {
  downloadSigned: boolean;
  /** What the viewer shows: the sealed copy once there is one, otherwise the file as it was sent. */
  viewKind: "final" | "base" | null;
  downloadOriginal: boolean;
  void: boolean;
}

export function documentActions(doc: ActionDoc, caps: Pick<DetailCaps, "void">): DocumentActions {
  const completed = doc.status === "completed" && !!doc.final_path;
  return {
    downloadSigned: completed,
    viewKind: completed ? "final" : doc.base_path && doc.mode !== "form" ? "base" : null,
    downloadOriginal: !!doc.original_path,
    void: caps.void && (doc.status === "sent" || doc.status === "in_progress"),
  };
}

export interface SignerActions {
  /** The person was invited and has not finished, and the document is still open. */
  open: boolean;
  remind: boolean;
  /** Remind is held back because one went out less than a day ago; the moment it can be sent again. */
  remindAfter: Date | null;
  resend: boolean;
  changeRecipient: boolean;
  /** An ordered document that has not reached this person yet. */
  notInvited: boolean;
  /** A person whose step has not begun can move to a later step (F-70). */
  move: boolean;
}

export function signerActions(
  docStatus: string,
  signer: Pick<SignSignerRow, "status" | "last_reminded_at">,
  caps: Pick<DetailCaps, "send">,
  now: Date,
  /** The document needs signing order (a step can only be moved in one that does). */
  ordered = false,
): SignerActions {
  const docOpen = docStatus === "sent" || docStatus === "in_progress";
  const invited = signer.status === "sent" || signer.status === "viewed";
  const open = docOpen && invited;
  const last = signer.last_reminded_at ? new Date(signer.last_reminded_at) : null;
  const heldUntil = last && !Number.isNaN(last.getTime()) ? new Date(last.getTime() + REMIND_GAP_MS) : null;
  const held = heldUntil !== null && heldUntil.getTime() > now.getTime();
  const allowed = open && caps.send;
  const notInvited = docOpen && signer.status === "pending";
  return {
    open,
    remind: allowed && !held,
    remindAfter: allowed && held ? heldUntil : null,
    resend: allowed,
    // a person who has not been invited yet can be renamed or re-addressed too (no message goes until their step begins)
    changeRecipient: allowed || (notInvited && caps.send),
    notInvited,
    move: notInvited && caps.send && ordered,
  };
}

// ---- recipients ----------------------------------------------------------------------------

export interface RecipientForm {
  fullName: string;
  email: string;
  phone: string;
  channel: "email" | "whatsapp";
}

export type RecipientProblem = "name" | "email" | "phone";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+\d{8,15}$/;

/** What is wrong with a new recipient, mirroring the server's checks so the dialog can say so at once. */
export function recipientProblems(f: RecipientForm): RecipientProblem[] {
  const out: RecipientProblem[] = [];
  if (!f.fullName.trim()) out.push("name");
  if (!EMAIL_RE.test(f.email.trim())) out.push("email");
  const phone = f.phone.replace(/[\s\-().]/g, "");
  if (f.channel === "whatsapp" ? !PHONE_RE.test(phone) : phone !== "" && !PHONE_RE.test(phone)) out.push("phone");
  return out;
}

// ---- messages that did not arrive ----------------------------------------------------------

export interface DeliveryEvent {
  type: string;
  signer_id: string | null;
  detail: Record<string, unknown> | null;
  doc_seq: number;
}

/**
 * The people whose latest message about signing did not arrive. A failure stands until that person is
 * invited, reminded, sent a new link or given a new recipient and the message then goes through (each of those
 * is recorded first, and a failure after it is recorded last). A failure to deliver the signed copy is not
 * about getting someone to sign, so it does not count.
 */
export function signersWithUndelivered(events: readonly DeliveryEvent[]): Set<string> {
  const out = new Set<string>();
  const ordered = [...events].sort((a, b) => a.doc_seq - b.doc_seq);
  for (const e of ordered) {
    if (!e.signer_id) continue;
    if (e.type === "invited" || e.type === "resent" || e.type === "reminded" || e.type === "recipient_changed" || e.type === "forwarded") out.delete(e.signer_id);
    else if (e.type === "delivery_failed" && e.detail?.kind !== "completed") out.add(e.signer_id);
  }
  return out;
}

// ---- failure codes -------------------------------------------------------------------------

/** Failure codes this screen words itself; anything else reads as the generic sentence. */
export const DETAIL_ERROR_CODES = [
  "document_not_found",
  "signer_not_found",
  "signer_not_open",
  "signer_details",
  "already_on_document",
  "step_not_movable",
  "document_not_open",
  "document_already_final",
  // envelopes (migration 171)
  "envelope_not_found",
  "envelope_not_sent",
  "envelope_partly_completed",
  "envelope_person_has_signed",
  "document_in_envelope",
  "expiry_in_the_past",
  "expiry_not_later",
  "expiry_too_far",
  "bad_expiry",
  "invalid_status_move",
  "reason_required",
  "no_final_file",
  "no_original_file",
  "no_file",
  "bad_action",
  "forbidden",
  "signed_out",
  "rate_limited",
  "network",
  "database_error",
] as const;

const KNOWN: ReadonlySet<string> = new Set(DETAIL_ERROR_CODES);

/** The message key, under `Sign.detail`, for a failure code. */
export function detailErrorKey(code: string | null | undefined): string {
  return code && KNOWN.has(code) ? `errors.${code}` : "errors.generic";
}
