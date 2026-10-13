// ============================================================
// Compliance requests, the personal closure form link in a chat (migration 185): making it, sending it, sending it again, withdrawing it, and the status
// of the cards in the Inbox. SERVER ONLY (the key ring and the send pipeline are Node).
//
// THE ORDER. The case exists FIRST (raise.ts makes it: source inbox, linked to the contact and the conversation, status received, its clock running from the
// request time). Only then is a link minted for it, and then the card is put in the chat. If anything after the case fails, the case still stands and the
// agent is told, with the link to copy.
//
// WHAT IS KEPT. The token is 256 random bits shown once; the database keeps only its keyed hash (token.ts). The address goes to the channel and to the agent
// who just made it when the channel could not take it (`ChatLinkOutcome.not_sent.url`, once), and nowhere else: not the message row (it keeps the card's
// words and the link's id), not the timeline (it names the action, the channel and the link's id), not a log.
//
// WHO. Sending, sending again and withdrawing need compliance.raise, compliance.review or compliance.approve. A holder of review or approve may act on any
// case; a person who holds only compliance.raise may act on the cases they raised themselves. The database checks the capability again for the named person.
//
// MANUAL. An agent starts it (the checkbox in the raise dialog, or Resend). Nothing here sends by itself, and nothing here sends a WhatsApp template:
// outside the 24-hour window the link is made and the agent gets a plain explanation and Copy link.
// ============================================================

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadWhatsappWindowOpen } from "@/lib/messages/window";
import { publicOrigin } from "@/lib/site-url";
import { SendMessageError, sendMessageToConversation } from "@/lib/whatsapp/send-message";

import { complianceError, fromDatabase } from "../errors";
import { loadRow } from "../service/read";
import { cardLocale } from "./card";
import { planDelivery } from "./channels";
import { mayActOnLink, type LinkActor } from "./read";
import { linkPath, linkTokensConfigured, mintLinkToken } from "./token";
import type { ChatLinkOutcome, NotSentReason } from "./types";

export interface ChatLinkDeps {
  now: () => Date;
  /** `https://halo.example` (no trailing slash). */
  origin: () => string;
  windowOpen: (admin: SupabaseClient, conversationId: string) => Promise<boolean>;
  send: typeof sendMessageToConversation;
}

export const realChatLinkDeps: ChatLinkDeps = {
  now: () => new Date(),
  origin: () => publicOrigin(),
  windowOpen: (admin, conversationId) => loadWhatsappWindowOpen(admin, conversationId),
  send: sendMessageToConversation,
};

/** The real dependencies for a request: the site's address (the configured one, else the one the request came in on). */
export const chatLinkDepsFor = (request: Request): ChatLinkDeps => ({ ...realChatLinkDeps, origin: () => publicOrigin() || new URL(request.url).origin });

interface ConversationRow {
  id: string;
  last_channel_type: string | null;
  contact: { language: string | null } | { language: string | null }[] | null;
}

async function loadConversation(admin: SupabaseClient, accountId: string, conversationId: string): Promise<{ channel: string | null; language: string | null } | null> {
  const { data, error } = await admin.from("conversations").select("id, last_channel_type, contact:contacts(language)").eq("id", conversationId).eq("account_id", accountId).maybeSingle();
  if (error || !data) return null;
  const c = data as unknown as ConversationRow;
  const contact = Array.isArray(c.contact) ? c.contact[0] : c.contact;
  return { channel: c.last_channel_type, language: contact?.language ?? null };
}

/** The reason a send failed, in the named words the dialog knows (never the provider's). */
export function reasonOfSendError(err: unknown): NotSentReason {
  if (err instanceof SendMessageError) {
    if (err.code === "window_closed") return "window_expired";
    if (err.code === "link_card_unsupported") return "channel_unsupported";
    if (/not_configured$|_not_configured|channel_disabled|email_inbox_off/.test(err.code)) return "not_configured";
  }
  return "send_failed";
}

async function recordSent(admin: SupabaseClient, linkId: string, actor: string, messageId: string | null, delivered: boolean, resend: boolean, reason: NotSentReason | null): Promise<void> {
  const { error } = await admin.rpc("compliance_form_link_sent", {
    p_link: linkId,
    p_actor: actor,
    p_message: messageId,
    p_delivered: delivered,
    p_resend: resend,
    p_reason: reason,
  });
  // the message is already in the chat (or the failure already told to the agent): a trail that could not be written is logged and does not undo it
  if (error) console.error("[compliance] the closure form link outcome could not be recorded");
}

export interface SendFormInput {
  accountId: string;
  requestId: string;
  /** The login that is sending (a person: the database checks what they hold). */
  actor: string;
  /** The conversation the link goes into. Null: made but not sent (no chat to put it in). */
  conversationId: string | null;
  /** True when an earlier link existed for this case (it is replaced); the timeline then says "resent". */
  resend: boolean;
}

/**
 * Mint a personal closure form link for a case and put it in the conversation as a card. Never throws for a problem with the CHAT (the outcome says what
 * happened and gives the link to copy); throws only when the link itself could not be made (the case is not a closure, a permission, the database).
 */
export async function sendClosureForm(admin: SupabaseClient, deps: ChatLinkDeps, input: SendFormInput): Promise<ChatLinkOutcome> {
  if (!linkTokensConfigured()) return { status: "unavailable", reason: "no_key" };
  const row = await loadRow(admin, input.accountId, input.requestId);
  if (row.type_key !== "closure") return { status: "unavailable", reason: "not_closure" };

  const conversation = input.conversationId ? await loadConversation(admin, input.accountId, input.conversationId) : null;
  const channel = conversation?.channel ?? null;
  const locale = cardLocale(conversation?.language, row.customer_locale);

  const minted = mintLinkToken(randomUUID());
  if (!minted) return { status: "unavailable", reason: "no_key" };
  const { data, error } = await admin.rpc("compliance_mint_form_link", {
    p_request: row.id,
    p_actor: input.actor,
    p_link: minted.linkId,
    p_token_hash: minted.tokenHash,
    p_conversation: conversation ? input.conversationId : null,
    p_channel: channel,
    p_locale: locale,
    p_ttl_days: 14,
  });
  if (error) throw fromDatabase(error);
  const expiresAt = String((data as { expires_at?: string } | null)?.expires_at ?? "");
  const url = `${deps.origin().replace(/\/+$/, "")}${linkPath(minted.token)}`;

  const notSent = async (reason: NotSentReason, messageId: string | null): Promise<ChatLinkOutcome> => {
    await recordSent(admin, minted.linkId, input.actor, messageId, false, input.resend, reason);
    return { status: "not_sent", linkId: minted.linkId, expiresAt, reason, channel, url };
  };

  if (!conversation || !input.conversationId) return notSent("no_channel", null);
  const plan = planDelivery(channel, { whatsappWindowOpen: channel === "whatsapp" ? await deps.windowOpen(admin, input.conversationId) : false });
  if (!plan.send) return notSent(plan.reason, null);

  try {
    const result = await deps.send(admin, input.accountId, {
      conversationId: input.conversationId,
      messageType: "link_card",
      linkCard: { url, linkId: minted.linkId, locale },
      senderType: "agent",
      senderUserId: input.actor,
      channelOverride: channel as never,
      persistFailedAttempt: true,
    });
    await recordSent(admin, minted.linkId, input.actor, result.messageId, true, input.resend, null);
    return { status: "sent", linkId: minted.linkId, expiresAt, mode: plan.card ? "card" : "text", channel: channel as string };
  } catch (err) {
    console.error("[compliance] the closure form could not be put in the chat:", err instanceof SendMessageError ? err.code : "error");
    return notSent(reasonOfSendError(err), err instanceof SendMessageError ? err.failedMessageId : null);
  }
}

/** Send the case's closure form again: a new link, the old one stops working. The conversation is the one the case is linked to. */
export async function resendClosureForm(admin: SupabaseClient, deps: ChatLinkDeps, actor: LinkActor, requestId: string): Promise<ChatLinkOutcome> {
  const row = await loadRow(admin, actor.accountId, requestId);
  if (!mayActOnLink(actor, row)) throw complianceError("forbidden");
  return sendClosureForm(admin, deps, { accountId: actor.accountId, requestId: row.id, actor: actor.userId, conversationId: row.conversation_id, resend: true });
}

/** Withdraw the case's active link. `revoked` is false when there was none. */
export async function revokeClosureForm(admin: SupabaseClient, actor: LinkActor, requestId: string): Promise<{ revoked: boolean }> {
  const row = await loadRow(admin, actor.accountId, requestId);
  if (!mayActOnLink(actor, row)) throw complianceError("forbidden");
  const { data, error } = await admin.rpc("compliance_revoke_form_link", { p_request: row.id, p_actor: actor.userId });
  if (error) throw fromDatabase(error);
  return { revoked: typeof data === "string" && data !== "" };
}

export type { LinkActor };
