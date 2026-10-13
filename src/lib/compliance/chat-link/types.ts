// ============================================================
// Compliance requests, the personal closure form link in a chat: the shapes the server, the Inbox card, the raise dialog and the case page share. No I/O and
// no Node imports, so the browser may import this file. NOTHING here ever carries the link's address except `ChatLinkOutcome` with status "not_sent",
// which is handed once to the agent who made the link (the Copy link fallback) and never stored.
// ============================================================

import type { CustomerLocale, PersonRef } from "../types";
import type { LinkState } from "./link-state";

/** Why a link was made but not put in the chat. Named, so the dialog can word it; never the provider's words. */
export const NOT_SENT_REASONS = ["window_expired", "channel_unsupported", "send_failed", "no_channel", "not_configured"] as const;
export type NotSentReason = (typeof NOT_SENT_REASONS)[number];

/** What came of the closure form for the chat, as the raise route and the resend route answer. */
export type ChatLinkOutcome =
  /** In the chat. `mode` is how the channel shows it: a card with a button, or the plain-text line where it has no button. No address. */
  | { status: "sent"; linkId: string; expiresAt: string; mode: "card" | "text"; channel: string }
  /** Made, not sent. `url` is the personal address, shown ONCE to the agent who just made it (Copy link). */
  | { status: "not_sent"; linkId: string; expiresAt: string; reason: NotSentReason; channel: string | null; url: string }
  /** No link was made (the request is not a closure, the key to hash with is missing ...). */
  | { status: "unavailable"; reason: "not_closure" | "no_conversation" | "no_key" };

/** One link as the case page lists it (menu.compliance). No address, no hash. */
export interface FormLinkView {
  id: string;
  state: LinkState;
  channel: string | null;
  locale: string | null;
  createdAt: string;
  expiresAt: string;
  sentAt: string | null;
  openedAt: string | null;
  submittedAt: string | null;
  revokedAt: string | null;
  createdBy: PersonRef | null;
}

/** One card's status in the Inbox thread. `requestId` and `canManage` only for a person who may resend or withdraw it. */
export interface CardStatus {
  id: string;
  state: LinkState;
  expiresAt: string;
  canManage: boolean;
  requestId?: string;
}

/** What the browser needs to draw the personal form. Nothing stored beyond a name and an email as editable suggestions and the masked phone number. */
export interface LinkView {
  /** The page's signed form token (replay and speed protection), bound to the link. */
  token: string;
  /** The link's own token (it is in the address already): posted back with the form. */
  linkToken: string;
  workspace: { name: string; logoUrl: string | null };
  /** `+6012•••••881`, or null when the case has no phone number (the form then asks for it). */
  maskedPhone: string | null;
  /** Suggestions the parent can correct. */
  name: string;
  email: string;
  banks: string[];
  targetDays: number | null;
  /** The language the form opens in. */
  locale: CustomerLocale;
}
