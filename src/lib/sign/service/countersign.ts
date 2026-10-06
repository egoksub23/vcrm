// ============================================================
// Countersigning inside Halo, and the two shortcut lists of the documents screen.
//
// A role of a document can be a Halo user (sign_signers.internal_user_id, migration 157). Such a person signs on the
// same page as everybody else (/s/<link>), through the same endpoints, with the same consent and the same sealing; the
// one difference is how they are recognised. A signer from outside proves who they are with the link and, when the
// document asks for it, a code sent to their email. A Halo user is already signed in to Halo, so this module gives
// them a fresh link and the verified session for it, and the audit trail says exactly that (method "halo_login").
//
//   listAwaitingMe       the documents whose turn it is for the signed-in person ("Awaiting my signature")
//   openCountersign      a link for the signed-in person's own place on a document, and the session that skips the code
//   listNeedsAttention   documents that stopped (declined, expired, failed) and open ones whose message did not arrive
//   assertAccountMembers the people a sender names as Halo users really are members of this workspace
//
// Nothing here sends a message. A person can only ever open their own place: the signer is found by the signed-in
// person's own user id AND the workspace, never by a signer id from the browser.
// ============================================================

import { signersWithUndelivered } from "@/components/sign/detail/logic";

import { isOwnAddress, normalizeEmail } from "../test-mode";
import { createSession } from "../tokens";
import { turnState, type TurnState } from "../turn";
import type { Invitation, SignDocumentRow, SignSignerRow } from "../types";
import { loadDocument, logEvent, type SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";

/** The verification method recorded when a Halo user opens their own turn: their Halo sign-in stands in for the code. */
export const HALO_LOGIN_METHOD = "halo_login";

/** The most documents a list answers with. A person with more than this waiting has a bigger problem than a list. */
export const SHORTCUT_LIMIT = 100;

/** How long a document that stopped (declined, expired) stays under "Needs attention". Nobody clears them by hand. */
export const ATTENTION_DAYS = 30;

const DAY_MS = 24 * 3600 * 1000;

function requireUser(ctx: SignCtx): string {
  if (!ctx.userId) throw new SignError("signed_out", "Sign in to continue.", 401);
  return ctx.userId;
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ---- whose turn is it ---------------------------------------------------------------------------

const REFUSALS: Record<Exclude<TurnState, "open">, { code: string; message: string }> = {
  not_your_turn: { code: "not_your_turn", message: "It is not your turn to sign this document yet." },
  already_signed: { code: "already_signed", message: "You have already signed this document." },
  declined: { code: "signer_not_open", message: "You declined this document." },
  document_closed: { code: "document_not_open", message: "This document can no longer be signed." },
};

// ---- "Awaiting my signature" --------------------------------------------------------------------

export interface AwaitingItem {
  documentId: string;
  signerId: string;
  title: string;
  reference: string | null;
  /** The role of the document this person signs as, as the sender named it. */
  roleLabel: string;
  senderName: string | null;
  sentAt: string | null;
  expiresAt: string | null;
  /** The document asks signers to sign in order, and this is their step. */
  step: number | null;
}

/** The documents waiting for the signed-in person, oldest first. Only their own places on documents of this workspace. */
export async function listAwaitingMe(ctx: SignCtx): Promise<AwaitingItem[]> {
  const userId = requireUser(ctx);
  const s = await ctx.admin.from("sign_signers").select("*").eq("account_id", ctx.accountId).eq("internal_user_id", userId).in("status", ["sent", "viewed"]).limit(SHORTCUT_LIMIT * 2);
  if (s.error) raiseDatabaseError(s.error, "load my places");
  const mine = (s.data ?? []) as SignSignerRow[];
  if (mine.length === 0) return [];

  const d = await ctx.admin
    .from("sign_documents")
    .select("id, title, reference, status, created_by, sent_at, expires_at, sign_in_order, roles_snapshot, test")
    .eq("account_id", ctx.accountId)
    .in("status", ["sent", "in_progress"])
    .in("id", [...new Set(mine.map((x) => x.document_id))]);
  if (d.error) raiseDatabaseError(d.error, "load my documents");
  const docs = new Map(((d.data ?? []) as Pick<SignDocumentRow, "id" | "title" | "reference" | "status" | "created_by" | "sent_at" | "expires_at" | "sign_in_order" | "roles_snapshot" | "test">[]).map((x) => [x.id, x]));

  const creators = [...new Set([...docs.values()].map((x) => x.created_by).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (creators.length) {
    const p = await ctx.admin.from("profiles").select("user_id, full_name").eq("account_id", ctx.accountId).in("user_id", creators);
    for (const row of (p.data ?? []) as { user_id: string; full_name: string | null }[]) if (row.full_name?.trim()) names.set(row.user_id, row.full_name.trim());
  }

  const now = ctx.now();
  const items: AwaitingItem[] = [];
  for (const signer of mine) {
    const doc = docs.get(signer.document_id);
    if (!doc || turnState(doc, signer, now) !== "open") continue;
    items.push({
      documentId: doc.id,
      signerId: signer.id,
      // a test document (F-10) says so where it is listed
      title: doc.test ? `[TEST] ${doc.title}` : doc.title,
      reference: doc.reference,
      roleLabel: doc.roles_snapshot?.find((r) => r.key === signer.role_key)?.label ?? signer.role_key,
      senderName: doc.created_by ? (names.get(doc.created_by) ?? null) : null,
      sentAt: doc.sent_at,
      expiresAt: doc.expires_at,
      step: doc.sign_in_order ? signer.order_no : null,
    });
  }
  items.sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? "") || a.documentId.localeCompare(b.documentId));
  return items.slice(0, SHORTCUT_LIMIT);
}

// ---- opening the signer page from Halo ----------------------------------------------------------

/** The addresses a signed-in person is known by: the one on their profile in this workspace and the one they sign in with (when the sign-in record can be read). */
async function loginAddresses(ctx: SignCtx, userId: string): Promise<string[]> {
  const found = new Set<string>();
  const p = await ctx.admin.from("profiles").select("email").eq("user_id", userId).eq("account_id", ctx.accountId).maybeSingle();
  const profile = (p.data as { email?: string | null } | null)?.email;
  if (profile?.trim()) found.add(normalizeEmail(profile));
  try {
    const u = await ctx.admin.auth.admin.getUserById(userId);
    const email = u.data?.user?.email;
    if (email) found.add(normalizeEmail(email));
  } catch {
    // the profile's address is enough when the sign-in record cannot be read
  }
  return [...found];
}

export interface CountersignOpened {
  signerId: string;
  /** The fresh link token, for the caller to build the address from. Never logged. */
  token: string;
  /** The verified session for this signer (skips the code), or null when the server has no key to sign one with. */
  session: { value: string; maxAgeSeconds: number } | null;
}

/**
 * Open the signed-in person's own place on a document. Their old link stops (a link is rotated exactly as a reminder
 * rotates it, without sending anything), a new one is made, and the session that stands in for the email code is made
 * for that one signer. The audit trail records both: that a link was made for them from inside Halo, and that they
 * were identified by their Halo sign-in.
 *
 * Refused: someone who is not a signer on the document (403, the same answer whether or not the document exists, so
 * nothing can be probed), and 409 when it is not their turn yet, the document is no longer open, or they have already
 * signed or declined.
 */
export async function openCountersign(ctx: SignCtx, documentId: string, meta: { ip: string | null; device: string | null }): Promise<CountersignOpened> {
  const userId = requireUser(ctx);
  const found = await ctx.admin.from("sign_signers").select("*").eq("document_id", documentId).eq("account_id", ctx.accountId).eq("internal_user_id", userId);
  if (found.error) raiseDatabaseError(found.error, "load my place");
  const mine = ((found.data ?? []) as SignSignerRow[]).sort((a, b) => a.order_no - b.order_no || a.created_at.localeCompare(b.created_at));
  if (mine.length === 0) throw new SignError("not_a_signer", "You are not a signer on this document.", 403);
  // A Halo sign-in stands in for the emailed link and code, so it must be the person the place is ADDRESSED to. Whoever sent the document
  // chose which workspace member a place belongs to; without this, a sender could name themselves for someone else's name and address and
  // sign as them without ever having that person's mailbox. Only a place addressed to the person's own address (or that address with a +tag) opens.
  const addresses = await loginAddresses(ctx, userId);
  const addressed = mine.filter((signer) => isOwnAddress(signer.email, addresses));
  if (addressed.length === 0) throw new SignError("countersign_other_address", "This place is addressed to an email address that is not yours. Open the link that was sent to that address.", 403);

  const doc = await loadDocument(ctx, documentId);
  const now = ctx.now();
  const states = addressed.map((signer) => ({ signer, state: turnState(doc, signer, now) }));
  const chosen = states.find((x) => x.state === "open");
  if (!chosen) {
    // Say the most useful thing about the person's places: waiting is better news than finished, which is better than closed.
    const order: TurnState[] = ["not_your_turn", "already_signed", "declined", "document_closed"];
    const why = order.find((o) => states.some((x) => x.state === o)) ?? "document_closed";
    const r = REFUSALS[why as Exclude<TurnState, "open">];
    throw new SignError(r.code, r.message, 409);
  }
  const { signer } = chosen;

  // The same call a reminder makes, so the old link dies and nobody else's link is touched. The reason is its own event
  // type, so the history never says a message was sent when none was.
  // A document of an envelope is reached through the link of the person's first document (the anchor): the link and the session belong to that row
  // (a link made for any other row of the person would be a link to nothing).
  const anchorId = signer.party_id && signer.party_id !== signer.id ? signer.party_id : null;
  const { data, error } = signer.party_id
    ? await ctx.admin.rpc("sign_envelope_rotate_token", { p_anchor: signer.party_id, p_actor: userId, p_reason: "halo_link" })
    : await ctx.admin.rpc("sign_rotate_token", { p_signer: signer.id, p_actor: userId, p_reason: "halo_link" });
  if (error || !data) raiseDatabaseError(error, "open countersign");
  const token = (data as Invitation).token;
  if (!token) throw new SignError("database_error", "Something went wrong. Please try again.", 500);

  await logEvent(ctx, documentId, "code_verified", { actor: "signer", signerId: signer.id, userId, ip: meta.ip, device: meta.device, detail: { method: HALO_LOGIN_METHOD } });
  const linkOwner = anchorId ?? signer.id;
  return { signerId: linkOwner, token, session: createSession(linkOwner, now) };
}

// ---- the people a sender names ------------------------------------------------------------------

/** A Halo user named on a document must belong to this workspace: an id from anywhere else is refused. */
export async function assertAccountMembers(ctx: SignCtx, userIds: readonly string[]): Promise<void> {
  const wanted = [...new Set(userIds)];
  if (wanted.length === 0) return;
  const p = await ctx.admin.from("profiles").select("user_id").eq("account_id", ctx.accountId).in("user_id", wanted);
  if (p.error) raiseDatabaseError(p.error, "check the Halo users");
  const have = new Set(((p.data ?? []) as { user_id: string }[]).map((r) => r.user_id));
  if (wanted.some((id) => !have.has(id))) throw new SignError("signer_internal_user", "Choose a person from this workspace.", 400);
}

// ---- "Needs attention" --------------------------------------------------------------------------

export type AttentionReason = "declined" | "expired" | "failed" | "undelivered";

export interface AttentionItem {
  documentId: string;
  title: string;
  reference: string | null;
  status: SignDocumentRow["status"];
  /** Why it is here; a document can have more than one. */
  reasons: AttentionReason[];
  /** The people it is about: who declined, who was left waiting, whose message did not arrive. */
  people: string[];
  /** When it happened (the document stopped, or the last message failed). */
  at: string;
}

type AttentionDoc = Pick<SignDocumentRow, "id" | "title" | "reference" | "status" | "updated_at">;

/**
 * What a sender should look at: documents that declined, expired in the last 30 days or failed to seal, and open ones
 * where a message to someone did not arrive and has not been put right since (a reminder, a new link or a changed
 * recipient that then went through clears it). Only the failures the app saw are known: a message the mail provider
 * accepted and bounced later is not recorded anywhere, so it cannot appear here.
 * A test document (F-10) is the sender's own rehearsal and never appears here.
 */
export async function listNeedsAttention(ctx: SignCtx): Promise<AttentionItem[]> {
  const cutoff = new Date(ctx.now().getTime() - ATTENTION_DAYS * DAY_MS).toISOString();
  const columns = "id, title, reference, status, updated_at";
  const [recent, failed, open] = await Promise.all([
    ctx.admin.from("sign_documents").select(columns).eq("account_id", ctx.accountId).neq("test", true).in("status", ["declined", "expired"]).gte("updated_at", cutoff).limit(SHORTCUT_LIMIT * 2),
    ctx.admin.from("sign_documents").select(columns).eq("account_id", ctx.accountId).neq("test", true).eq("status", "failed").limit(SHORTCUT_LIMIT),
    ctx.admin.from("sign_documents").select(columns).eq("account_id", ctx.accountId).neq("test", true).in("status", ["sent", "in_progress"]).order("updated_at", { ascending: false }).limit(500),
  ]);
  for (const r of [recent, failed, open]) if (r.error) raiseDatabaseError(r.error, "load the documents that need attention");
  const stopped = [...((recent.data ?? []) as AttentionDoc[]), ...((failed.data ?? []) as AttentionDoc[])];
  const openDocs = (open.data ?? []) as AttentionDoc[];

  // delivery failures of the open documents, and what has been done about them since
  const failures = new Map<string, { at: string; people: Set<string> }>();
  const peopleOf = new Map<string, SignSignerRow[]>();
  for (const ids of chunk(openDocs.map((d) => d.id), 100)) {
    const ev = await ctx.admin.from("sign_events").select("document_id, doc_seq, signer_id, type, detail, created_at").eq("account_id", ctx.accountId).in("document_id", ids).in("type", ["delivery_failed", "invited", "resent", "reminded", "recipient_changed"]);
    if (ev.error) raiseDatabaseError(ev.error, "load delivery results");
    const byDoc = new Map<string, { doc_seq: number; signer_id: string | null; type: string; detail: Record<string, unknown> | null; created_at: string }[]>();
    for (const e of (ev.data ?? []) as { document_id: string; doc_seq: number; signer_id: string | null; type: string; detail: Record<string, unknown> | null; created_at: string }[]) {
      const list = byDoc.get(e.document_id) ?? [];
      list.push(e);
      byDoc.set(e.document_id, list);
    }
    for (const [docId, list] of byDoc) {
      const stuck = signersWithUndelivered(list);
      if (stuck.size === 0) continue;
      const last = list.filter((e) => e.type === "delivery_failed" && e.signer_id && stuck.has(e.signer_id)).sort((a, b) => b.doc_seq - a.doc_seq)[0];
      failures.set(docId, { at: last?.created_at ?? "", people: stuck });
    }
  }

  const needed = [...stopped.map((d) => d.id), ...failures.keys()];
  for (const ids of chunk(needed, 100)) {
    const sg = await ctx.admin.from("sign_signers").select("*").eq("account_id", ctx.accountId).in("document_id", ids);
    if (sg.error) raiseDatabaseError(sg.error, "load the people of those documents");
    for (const s of (sg.data ?? []) as SignSignerRow[]) {
      const list = peopleOf.get(s.document_id) ?? [];
      list.push(s);
      peopleOf.set(s.document_id, list);
    }
  }

  const items: AttentionItem[] = [];
  for (const doc of stopped) {
    const signers = peopleOf.get(doc.id) ?? [];
    const reason: AttentionReason = doc.status === "declined" ? "declined" : doc.status === "expired" ? "expired" : "failed";
    const who = reason === "declined" ? signers.filter((s) => s.status === "declined") : reason === "expired" ? signers.filter((s) => s.status !== "signed" && s.status !== "declined" && s.status !== "pending") : [];
    items.push({ documentId: doc.id, title: doc.title, reference: doc.reference, status: doc.status, reasons: [reason], people: who.map((s) => s.full_name), at: doc.updated_at });
  }
  for (const doc of openDocs) {
    const f = failures.get(doc.id);
    if (!f) continue;
    const signers = (peopleOf.get(doc.id) ?? []).filter((s) => f.people.has(s.id) && (s.status === "sent" || s.status === "viewed"));
    // someone who has since signed or declined needs no message: the failure is moot
    if (signers.length === 0) continue;
    items.push({ documentId: doc.id, title: doc.title, reference: doc.reference, status: doc.status, reasons: ["undelivered"], people: signers.map((s) => s.full_name), at: f.at || doc.updated_at });
  }
  items.sort((a, b) => b.at.localeCompare(a.at) || a.documentId.localeCompare(b.documentId));
  return items.slice(0, SHORTCUT_LIMIT);
}
