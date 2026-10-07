// ============================================================
// Envelopes (migration 171): telling the people. ONE invitation, ONE reminder and ONE completion message for each person of an
// envelope, whatever the number of documents. The invitations come back from the database one per person (the link belongs to the
// person's first document); this module words and delivers them and records a failure on the chain of the document the link is on.
// Never throws: a message that could not be delivered is something to record, not a reason to fail the action.
// ============================================================

import { deliverEnvelopeCompleted, deliverEnvelopeInvitation, deliverEnvelopeReminder, deliverOutcome, type Delivery, type EnvelopeFacts, type Outcome, type Workspace } from "../notify";
import { isDelegate } from "../forward";
import { isFormMode, type Invitation, type SignDocumentRow, type SignEnvelopeRow, type SignSignerRow } from "../types";
import { loadSenderAndWorkspace, loadSettings, logEvent, type SignCtx } from "./context";
import { sendEnvelopeCopies, type CopyFile } from "./copy-delivery";
import { loadEnvelopeSigners, groupByParty, anchorOf } from "./envelope-data";
import type { InvitationResult } from "./send";

/** What an envelope's messages say. `mode` is `form` only when every document is a form without a signature. */
export function envelopeFacts(env: SignEnvelopeRow, docs: readonly SignDocumentRow[], ctx: SignCtx): EnvelopeFacts {
  return {
    accountId: ctx.accountId,
    title: env.title,
    reference: env.reference,
    locale: env.locale,
    expiresAt: env.expires_at ? new Date(env.expires_at) : null,
    codeRequired: env.code_required,
    message: env.message,
    documents: docs.map((d) => d.title),
    ...(docs.length > 0 && docs.every((d) => isFormMode(d)) ? { mode: "form" as const } : {}),
  };
}

export async function envelopeWorkspace(ctx: SignCtx, createdBy: string | null): Promise<Workspace> {
  const [info, settings] = await Promise.all([loadSenderAndWorkspace(ctx, createdBy), loadSettings(ctx)]);
  return { name: info.workspaceName, senderName: info.senderName, timeZone: info.timeZone, settings };
}

/** The document each invitation's link is on (its anchor row), for recording a failed delivery on the right chain. */
async function anchorDocuments(ctx: SignCtx, signerIds: readonly string[]): Promise<Map<string, string>> {
  if (signerIds.length === 0) return new Map();
  const { data } = await ctx.admin.from("sign_signers").select("id, document_id").in("id", [...signerIds]).eq("account_id", ctx.accountId);
  return new Map(((data ?? []) as { id: string; document_id: string }[]).map((r) => [r.id, r.document_id]));
}

/**
 * Deliver the invitations (or, with `reminder`, reminders) the database gave back for an envelope: one per person. A reminder names only
 * the documents that person has not finished. A link is handed back only for a message that could not be delivered, so the sender can
 * pass it on; it is never logged.
 */
export async function deliverEnvelopeInvitations(
  ctx: SignCtx,
  env: SignEnvelopeRow,
  docs: readonly SignDocumentRow[],
  invited: readonly Invitation[],
  opts: { reminder?: boolean; w?: Workspace } = {},
): Promise<InvitationResult[]> {
  const w = opts.w ?? (await envelopeWorkspace(ctx, env.created_by));
  const facts = envelopeFacts(env, docs, ctx);
  const homes = await anchorDocuments(ctx, invited.map((i) => i.signer_id));
  const parties = groupByParty(await loadEnvelopeSigners(ctx, docs.map((d) => d.id)), docs);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const out: InvitationResult[] = [];
  for (const inv of invited) {
    // the message names this person's own documents (a person is not always on every one), and for a reminder only what is left
    const theirs = (parties.get(inv.signer_id) ?? []).filter((r) => !opts.reminder || ((r.status === "sent" || r.status === "viewed") && ["sent", "in_progress"].includes(byId.get(r.document_id)?.status ?? "")));
    const titles = theirs.flatMap((r) => byId.get(r.document_id)?.title ?? []);
    const personal: EnvelopeFacts = { ...facts, documents: titles.length > 0 ? titles : facts.documents };
    const delivery: Delivery = opts.reminder
      ? await deliverEnvelopeReminder(ctx.admin, ctx.deps, ctx.origin, personal, w, inv)
      : await deliverEnvelopeInvitation(ctx.admin, ctx.deps, ctx.origin, personal, w, inv, { fill: inv.kind === "filler" });
    if (delivery.status !== "sent") {
      const doc = homes.get(inv.signer_id) ?? docs[0]?.id;
      if (doc) await logEvent(ctx, doc, "delivery_failed", { actor: "system", signerId: inv.signer_id, detail: { channel: delivery.channel, status: delivery.status, reason: delivery.detail ?? null } });
    }
    out.push({
      signerId: inv.signer_id,
      name: inv.name,
      roleKey: inv.role_key,
      delivery,
      ...(delivery.status === "sent" ? {} : { link: `${ctx.origin.replace(/\/+$/, "")}/s/${inv.token}` }),
    });
  }
  return out;
}

/** The people of an envelope to tell: each person once (the anchor's details), and never a person who was handed only a part. */
export function peopleOf(rows: readonly SignSignerRow[], docs: readonly SignDocumentRow[]): SignSignerRow[] {
  const out: SignSignerRow[] = [];
  for (const list of groupByParty(rows.filter((r) => !isDelegate(r)), docs).values()) {
    const anchor = anchorOf(list);
    if (anchor) out.push(anchor);
  }
  return out;
}

/** Tell the people of an envelope how it ended when it did not complete (once for each person), and the sender. */
export async function notifyEnvelopeEnded(ctx: SignCtx, env: SignEnvelopeRow, docs: readonly SignDocumentRow[], outcome: Outcome, opts: { except?: readonly string[] } = {}): Promise<void> {
  try {
    const [info, w, rows] = await Promise.all([loadSenderAndWorkspace(ctx, env.created_by), envelopeWorkspace(ctx, env.created_by), loadEnvelopeSigners(ctx, docs.map((d) => d.id))]);
    const facts = envelopeFacts(env, docs, ctx);
    const doc = { accountId: facts.accountId, title: facts.title, reference: facts.reference, locale: facts.locale, expiresAt: facts.expiresAt, codeRequired: facts.codeRequired, message: facts.message, ...(facts.mode ? { mode: facts.mode } : {}) };
    if (info.senderEmail && outcome.kind !== "voided") await deliverOutcome(ctx.deps, doc, w, { name: info.senderName, email: info.senderEmail, channel: "email", locale: env.locale }, outcome);
    const skip = new Set(opts.except ?? []);
    for (const p of peopleOf(rows, docs)) {
      // someone invited and not finished, on any document that was open
      const theirs = groupByParty(rows, docs).get(p.party_id ?? p.id) ?? [p];
      if (skip.has(p.id) || !p.invited_at || theirs.every((r) => r.status === "signed" || r.status === "declined")) continue;
      await deliverOutcome(ctx.deps, doc, w, { name: p.full_name, email: p.email, channel: p.channel, locale: p.locale ?? env.locale }, outcome);
    }
  } catch (err) {
    console.error("[sign] could not notify the end of the envelope:", env.id, err instanceof Error ? err.message : err);
  }
}

/**
 * The signed copies to each person and to the sender in ONE message each: every document's file, attached while they fit; then, in this same step and
 * once, to each person who receives a copy (migration 175). Never throws.
 */
export async function notifyEnvelopeCompleted(ctx: SignCtx, env: SignEnvelopeRow, docs: readonly SignDocumentRow[], files: readonly CopyFile[]): Promise<void> {
  try {
    const [info, w, rows] = await Promise.all([loadSenderAndWorkspace(ctx, env.created_by), envelopeWorkspace(ctx, env.created_by), loadEnvelopeSigners(ctx, docs.map((d) => d.id))]);
    const facts = envelopeFacts(env, docs, ctx);
    const people = peopleOf(rows, docs).map((s) => ({ name: s.full_name, email: s.email, channel: s.channel, locale: s.locale ?? env.locale, signerId: s.id as string | null }));
    if (info.senderEmail && !people.some((p) => p.email.toLowerCase() === info.senderEmail!.toLowerCase())) {
      people.push({ name: info.senderName, email: info.senderEmail, channel: "email", locale: env.locale, signerId: null });
    }
    for (const p of people) {
      const d = await deliverEnvelopeCompleted(ctx.deps, facts, w, p, files);
      if (d.status !== "sent") {
        const home = p.signerId ? rows.find((r) => r.id === p.signerId)?.document_id : docs[0]?.id;
        if (home) await logEvent(ctx, home, "delivery_failed", { actor: "system", signerId: p.signerId, detail: { kind: "completed", status: d.status, reason: d.detail ?? null } });
      }
    }
    await sendEnvelopeCopies(ctx, env.id, docs, facts, w, files, new Set(people.map((p) => p.email.trim().toLowerCase())));
  } catch (err) {
    console.error("[sign] could not notify the completion of the envelope:", env.id, err instanceof Error ? err.message : err);
  }
}
