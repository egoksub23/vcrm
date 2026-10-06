// ============================================================
// Template test mode (F-10): send yourself a document made from a template, marked TEST, to see the whole flow (the email, the
// signing page, the sealed file) before a real person does.
//
// It goes through the same services as any document: a draft from the template (`createDraftFromTemplate`, which also lets a
// template that is still a draft be tried, so it can be tested before it is made active), the people, then `sendDocument`. What is
// different is decided by the document's `test` flag, in the places that own each rule:
//   limits        sendDocument skips `assertCanSendDocument`; migration 170 leaves tests out of `account_usage()`
//   webhooks and  outbound.ts emits nothing for a test document
//   automations
//   the mark      sendDocument stamps TEST on every page, sealing stamps the certificate pages (pdf/testmark.ts)
//   the words     docFacts puts [TEST] in front of the title of every message about it
//   retention     a trigger keeps a completed test document 30 days
// Never reachable from a bulk batch or the public API: those never pass `test`, and this is the only caller that does.
//
// The person is the signer of every role that needs one: their own address by default, or another address of their own (the same
// mailbox with a +tag), checked here, never taken on trust from the browser. They are named as the Halo user of each place, so the
// document is under "Awaiting my signature" and can be opened from inside Halo with no email at all.
// ============================================================

import { planTestSigners, nameFromEmail, normalizeEmail, type TestPlan } from "../test-mode";
import type { SignDocumentRow } from "../types";
import { loadDocument, type SignCtx } from "./context";
import { createDraftFromTemplate, deleteDraft, setSigners, updateDraft } from "./drafts";
import { SignError } from "./errors";
import { sendDocument, type InvitationResult } from "./send";

export interface TestSendResult {
  documentId: string;
  reference: string | null;
  /** Where each place was sent, and the link when a message could not be delivered (so the person can open it anyway). */
  invited: InvitationResult[];
  /** The addresses that were used, by role. */
  people: { roleKey: string; email: string }[];
  /** The template signs in order and one address holds several places: the test document does not. */
  orderIgnored: boolean;
}

/** The addresses that are the signed-in person's own: the one they sign in with and the one on their profile. Never throws. */
export async function ownAddresses(ctx: SignCtx): Promise<{ addresses: string[]; name: string | null }> {
  const found = new Set<string>();
  let name: string | null = null;
  if (ctx.userId) {
    const p = await ctx.admin.from("profiles").select("full_name, email").eq("user_id", ctx.userId).eq("account_id", ctx.accountId).maybeSingle();
    const row = p.data as { full_name?: string | null; email?: string | null } | null;
    if (row?.email?.trim()) found.add(normalizeEmail(row.email));
    if (row?.full_name?.trim()) name = row.full_name.trim();
    try {
      const u = await ctx.admin.auth.admin.getUserById(ctx.userId);
      const email = u.data?.user?.email;
      if (email) found.add(normalizeEmail(email));
    } catch {
      // the profile's address is enough when the sign-in record cannot be read
    }
  }
  return { addresses: [...found], name };
}

export async function sendTestDocument(ctx: SignCtx, templateId: string, input: { email?: string | null; emails?: Record<string, string | undefined> } = {}): Promise<TestSendResult> {
  if (!ctx.userId) throw new SignError("signed_out", "Sign in to continue.", 401);
  const own = await ownAddresses(ctx);
  const defaultEmail = input.email?.trim() ? normalizeEmail(input.email) : (own.addresses[0] ?? "");
  if (!defaultEmail) throw new SignError("test_no_address", "Your account has no email address to send the test to.", 400);

  let doc: SignDocumentRow = await createDraftFromTemplate(ctx, { templateId, test: true });
  try {
    const planned = planTestSigners({
      roles: doc.roles_snapshot,
      fields: doc.fields_snapshot,
      form: doc.form_snapshot,
      signInOrder: doc.sign_in_order,
      name: own.name ?? nameFromEmail(defaultEmail),
      defaultEmail,
      own: own.addresses,
      emails: input.emails,
    });
    if (!planned.ok) {
      throw planned.error.code === "test_email_not_yours"
        ? new SignError("test_email_not_yours", "A test can only be sent to your own address (or your own address with a +tag).", 400, [{ code: "test_email_not_yours", ...(planned.error.role ? { role: planned.error.role } : {}) }])
        : new SignError("test_no_roles", "This template has nobody to sign or fill it in yet. Add a role with a field first.", 409);
    }
    const plan: TestPlan = planned.plan;
    // no reminders for a rehearsal; the order is dropped only when one address holds several places, which a document in order refuses
    doc = await updateDraft(ctx, doc.id, { reminderDays: [], ...(plan.orderIgnored ? { signInOrder: false } : {}) });
    await setSigners(
      ctx,
      doc.id,
      plan.signers.map((s) => ({ roleKey: s.roleKey, kind: s.kind, fullName: s.fullName, email: s.email, channel: "email" as const, orderNo: s.orderNo, internalUserId: ctx.userId })),
    );
    const sent = await sendDocument(ctx, doc.id);
    return {
      documentId: doc.id,
      reference: sent.reference,
      invited: sent.invited,
      people: plan.signers.map((s) => ({ roleKey: s.roleKey, email: s.email })),
      orderIgnored: plan.orderIgnored,
    };
  } catch (err) {
    // leave no half-made test behind: a draft that never went out is deleted (one that did is a real, sent document and stays)
    const now = await loadDocument(ctx, doc.id).catch(() => null);
    if (now?.status === "draft") await deleteDraft(ctx, doc.id).catch(() => undefined);
    throw err;
  }
}
