// ============================================================
// Settings > Doc Sign > Email: which way the workspace's email goes out (its connected Gmail mailbox, the platform sender, or nowhere yet) and a test
// email to the person asking. Read only: nothing here changes how email is sent; the transport is chosen by notify.ts for every message.
// ============================================================

import type { MailboxProblem, MailboxProvider } from "@/lib/email/mailbox-types";
import { reasonOfDetail, technicalOfDetail, type SendReason } from "@/lib/email/send-reason";

import { chooseEmailTransport, deliverTestEmail } from "../notify";
import { SignError } from "./errors";
import { loadSettings, type SignCtx } from "./context";

export interface EmailStatus {
  via: "mailbox" | "platform" | "none";
  /** Which kind of mailbox: the one mail is sent through, or the one that cannot send. Null when there is no mailbox, or it could not be read. */
  provider: MailboxProvider | null;
  /** The connected mailbox: the address mail is sent from, or the one that cannot send now (see `problem`). */
  address: string | null;
  /** A connected mailbox that cannot send now: the fix is to reconnect or switch it on, not to connect one. */
  problem: MailboxProblem | null;
  /** The name recipients see next to the address. */
  fromName: string | null;
}

/** Which way email goes out for the workspace, as the Settings card says it. */
export async function describeEmail(ctx: SignCtx): Promise<EmailStatus> {
  const [transport, settings, identity] = await Promise.all([chooseEmailTransport(ctx.deps, ctx.accountId), loadSettings(ctx), ctx.deps.loadIdentity(ctx.accountId)]);
  const fromName = settings.sender_name?.trim() || identity.fromName || null;
  if (transport.via === "mailbox") return { via: "mailbox", provider: transport.provider, address: transport.address, problem: null, fromName };
  if (transport.via === "platform") return { via: "platform", provider: transport.skipped?.provider ?? null, address: transport.skipped?.address || null, problem: transport.skipped?.problem ?? null, fromName };
  return { via: "none", provider: transport.problem?.provider ?? null, address: transport.problem?.address || null, problem: transport.problem?.problem ?? null, fromName };
}

export interface TestEmailResult {
  /** The test email was handed to the mail service. */
  sent: boolean;
  via: EmailStatus["via"];
  /** Which kind of mailbox it went through, and its address, when it went through one. */
  provider: MailboxProvider | null;
  from: string | null;
  /** Where it went: the address of the person who asked. */
  to: string;
  /** Why it did not go, as a word the screen can say in the reader's language; null when it did go, or when the failure is not one we recognise. */
  reason: SendReason | null;
  /** What the mail service said, for the cases `reason` does not cover (and as the technical detail under a named reason). */
  detail: string | null;
}

/**
 * One short email to the signed-in person's own address, through the transport the workspace has. Always answers: a failure is a result with its
 * reason, not an error. The address is the one on the person's profile, never one the browser sends.
 */
export async function sendTestEmail(ctx: SignCtx): Promise<TestEmailResult> {
  if (!ctx.userId) throw new SignError("no_email", "There is no email address to send the test to.", 400);
  const profile = await ctx.admin.from("profiles").select("email").eq("user_id", ctx.userId).eq("account_id", ctx.accountId).maybeSingle();
  const to = ((profile.data as { email?: string | null } | null)?.email ?? "").trim();
  if (!to) throw new SignError("no_email", "Your profile has no email address to send the test to.", 400);

  const [settings, identity, acct] = await Promise.all([
    loadSettings(ctx),
    ctx.deps.loadIdentity(ctx.accountId),
    ctx.admin.from("accounts").select("name, brand_name").eq("id", ctx.accountId).maybeSingle(),
  ]);
  const a = acct.data as { name?: string | null; brand_name?: string | null } | null;
  const workspace = a?.brand_name?.trim() || a?.name || "Halo";
  const { delivery, via, provider, from } = await deliverTestEmail(ctx.deps, ctx.accountId, to, settings.default_language, workspace, settings.sender_name?.trim() || identity.fromName || null);
  const sent = delivery.status === "sent";
  return {
    sent,
    via,
    provider,
    from,
    to,
    reason: sent ? null : reasonOfDetail(delivery.detail),
    detail: sent ? null : technicalOfDetail(delivery.detail) || null,
  };
}
