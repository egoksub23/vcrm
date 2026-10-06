// ============================================================
// Forwarding (F-95): a signer hands their whole turn, or one part of a form, to someone else, and takes a part
// back before it is completed. Every state change is decided by the database under the lock on the document
// (migration 166: sign_forward_turn, sign_forward_part, sign_take_back_part); this file checks what can be
// checked before asking, delivers the message the new person gets, tells the sender, and leaves nothing in
// the audit trail but what the database wrote (a name and a masked address, never a link or a token).
//
//   a turn   the new person replaces the signer on the same position; the old link stops at once; they give
//            their own consent. The sender is told inside Halo (the database) and by email (here).
//   a part   a delegate (a filler of the same role) holds the part and sees nothing else; the signer cannot
//            finish while the part is out, and may take it back until it is completed.
//
// The sender switches forwarding on and off for a document (`setForwarding`); a template carries the default.
// ============================================================

import { pick } from "../forms";
import { FORWARD_NOTE_MAX, MAX_FORWARDS, forwardProblem, partsAnswered } from "../forward";
import { deliverForward, deliverForwardNotice, type Delivery } from "../notify";
import type { Invitation, SignDocumentRow } from "../types";
import { loadDocument, loadSenderAndWorkspace, loadSettings, loadSigners, logEvent, type SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";
import { formOf } from "./form-state";
import { docFacts } from "./send";
import { assertOpen, type Lookup } from "./signing";

export interface ForwardInput {
  fullName: string;
  email: string;
  /** What the forwarder says to the new person (optional). */
  note?: string | null;
  /** Hand over only this part of the form; absent for the whole turn. */
  part?: string | null;
}

export interface ForwardResult {
  /** `turn` or `part`. */
  scope: "turn" | "part";
  /** The new person's name, for the forwarder's confirmation. */
  to: string;
  /** Whether the message to them was delivered (when it was not, the sender can send it again). */
  delivery: Delivery;
  /** Forwards left for this position. */
  remaining: number;
}

type RateLimit = (key: string, limit: number, windowMs: number) => Promise<boolean>;

/** A forward is a rare act: a handful an hour for one position is more than a person needs. */
export const FORWARDS_PER_HOUR = 6;

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function cleanNote(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new SignError("forward_details", "The note is not valid.", 400);
  const t = raw.normalize("NFC").replace(CONTROL_RE, "").trim();
  if (t.length > FORWARD_NOTE_MAX) throw new SignError("forward_details", `The note can be up to ${FORWARD_NOTE_MAX} characters.`, 400);
  return t || null;
}

/**
 * Hand the signer's whole turn, or (with `part`) one part of the form, to someone else. The caller has already
 * checked the code, when the document asks for one. Throws a SignError for anything the rules refuse.
 */
export async function forwardFromLink(ctx: SignCtx, lookup: Lookup, input: ForwardInput, meta: { ip: string | null; device: string | null }, rateLimit: RateLimit): Promise<ForwardResult> {
  assertOpen(lookup);
  const { doc, signer } = lookup;
  if (!doc.allow_forwarding) throw new SignError("forward_not_allowed", "Forwarding is not switched on for this document.", 403);
  if (signer.part_keys && signer.part_keys.length > 0) throw new SignError("delegate_cannot_forward", "A part that was handed to you cannot be passed on again.", 403);
  const name = String(input.fullName ?? "").trim();
  const email = String(input.email ?? "").trim();
  const note = cleanNote(input.note);

  const form = formOf(doc);
  const partKey = input.part ? String(input.part) : null;
  let partTitle: string | null = null;
  const everyone = await loadSigners(ctx, doc.id);
  if (partKey) {
    const part = form ? partsAnswered(form, signer, everyone).find((p) => p.key === partKey) : undefined;
    if (!form || !part) throw new SignError("forward_part_unknown", "That part is not yours to forward.", 400);
    partTitle = pick(part.title, doc.locale) || partKey;
  }

  // the same rules the database applies, so a person is told in plain words before anything is sent
  const others = everyone.filter((s) => s.id !== signer.id);
  const existing = partKey ? everyone.find((s) => s.delegated_by === signer.id && s.email.trim().toLowerCase() === email.toLowerCase() && (s.status === "sent" || s.status === "viewed")) : undefined;
  const problem = forwardProblem({ name, email }, { email: signer.email, role_key: signer.role_key, forwardCount: signer.forward_count ?? 0 }, { ordered: doc.sign_in_order }, others, { except: existing?.id });
  if (problem) throw new SignError(problem, FORWARD_PROBLEM_WORDS[problem], 400);

  if (!(await rateLimit(`sign:forward:${signer.id}`, FORWARDS_PER_HOUR, 3600_000))) throw new SignError("rate_limited", "You are doing that too often. Try again later.", 429);

  const { data, error } = partKey
    ? await ctx.admin.rpc("sign_forward_part", { p_signer: signer.id, p_part: partKey, p_name: name, p_email: email, p_max: MAX_FORWARDS, p_ip: meta.ip, p_device: meta.device })
    : await ctx.admin.rpc("sign_forward_turn", { p_signer: signer.id, p_name: name, p_email: email, p_max: MAX_FORWARDS, p_ip: meta.ip, p_device: meta.device });
  if (error || !data) raiseDatabaseError(error, "forward");
  const inv = data as Invitation & { forwarded_by?: string };

  // the new person's message, then the sender's; a message that fails is recorded, never an undone forward
  const [info, settings] = await Promise.all([loadSenderAndWorkspace(ctx, doc.created_by), loadSettings(ctx)]);
  const w = { name: info.workspaceName, senderName: info.senderName, settings, timeZone: info.timeZone };
  const facts = docFacts(doc, ctx);
  const delivery = await deliverForward(ctx.deps, ctx.origin, facts, w, inv, { forwarder: signer.full_name, note, part: partTitle });
  if (delivery.status !== "sent") {
    await logEvent(ctx, doc.id, "delivery_failed", { actor: "system", signerId: inv.signer_id, detail: { channel: delivery.channel, status: delivery.status, reason: delivery.detail ?? null } });
  }
  if (!partKey && info.senderEmail) {
    await deliverForwardNotice(ctx.deps, facts, w, { name: info.senderName, email: info.senderEmail, channel: "email", locale: doc.locale }, { name: signer.full_name, to: name });
  }
  return { scope: partKey ? "part" : "turn", to: name, delivery, remaining: Math.max(0, MAX_FORWARDS - ((signer.forward_count ?? 0) + 1)) };
}

const FORWARD_PROBLEM_WORDS = {
  forward_details: "Enter a full name and a valid email.",
  forward_same_person: "That is your own address. Enter the person you are handing this to.",
  forward_already_signer: "That person is already on this document.",
  forward_limit: "This can only be handed on a couple of times. Ask the sender instead.",
} as const;

/** Take a part back from the person it was handed to, before they have completed it. */
export async function takeBackFromLink(ctx: SignCtx, lookup: Lookup, partKey: string, meta: { ip: string | null; device: string | null }): Promise<{ part: string; removed: boolean }> {
  assertOpen(lookup);
  if (lookup.signer.part_keys && lookup.signer.part_keys.length > 0) throw new SignError("delegate_cannot_forward", "A part that was handed to you is not yours to take back.", 403);
  if (typeof partKey !== "string" || !partKey) throw new SignError("forward_part_unknown", "Choose a part.", 400);
  const { data, error } = await ctx.admin.rpc("sign_take_back_part", { p_signer: lookup.signer.id, p_part: partKey, p_ip: meta.ip, p_device: meta.device });
  if (error || !data) raiseDatabaseError(error, "take back");
  return { part: partKey, removed: !!(data as { removed_delegate?: boolean }).removed_delegate };
}

/**
 * The sender's switch for one document: people on it may forward a turn or a part, or may not. Allowed while the
 * document can still change; turning it off stops new forwards and leaves what is already handed over as it is.
 */
export async function setForwarding(ctx: SignCtx, documentId: string, allow: unknown): Promise<{ allowForwarding: boolean }> {
  if (typeof allow !== "boolean") throw new SignError("bad_forwarding", "Choose on or off.", 400);
  const doc: SignDocumentRow = await loadDocument(ctx, documentId);
  if (doc.status !== "draft" && doc.status !== "sent" && doc.status !== "in_progress") throw new SignError("document_not_open", "This document has finished: forwarding can no longer change.", 409);
  if (doc.allow_forwarding === allow) return { allowForwarding: allow };
  const { data, error } = await ctx.admin.from("sign_documents").update({ allow_forwarding: allow }).eq("id", documentId).eq("account_id", ctx.accountId).in("status", ["draft", "sent", "in_progress"]).select("id");
  if (error) raiseDatabaseError(error, "set forwarding");
  if (!data || (data as unknown[]).length === 0) throw new SignError("document_not_open", "This document has finished: forwarding can no longer change.", 409);
  if (doc.status !== "draft") await logEvent(ctx, documentId, "forwarding_changed", { actor: "user", userId: ctx.userId, detail: { allow } });
  return { allowForwarding: allow };
}
