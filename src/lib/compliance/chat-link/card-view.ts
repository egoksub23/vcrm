// ============================================================
// The closure form card in the Inbox thread (migration 185), the pure parts: what a `link_card` message row shows, which actions its status allows and how
// often the statuses are asked for. No I/O, no React, browser-safe.
//
// The row never holds the address: `content_text` is the card's title and `send_payload.link_card` its words and the link's id (card.ts). So nothing here can
// produce an address either.
// ============================================================

import { parseStoredCard } from "./card";
import type { CardStatus } from "./types";
import type { LinkState } from "./link-state";

/** How often the statuses are asked for while some card is still waiting on the customer and the tab is visible. */
export const CARD_POLL_MS = 30_000;

/** The link can still be used by the customer: the card may be withdrawn. */
export const ACTIVE_CARD_STATES: readonly LinkState[] = ["created", "sent", "opened"];

export const isActiveCardState = (state: LinkState): boolean => ACTIVE_CARD_STATES.includes(state);

/** Is any card in this list still waiting on the customer? (The only reason to keep asking.) */
export const anyCardActive = (links: readonly Pick<CardStatus, "state">[]): boolean => links.some((l) => isActiveCardState(l.state));

export interface CardView {
  linkId: string | null;
  title: string;
  body: string;
  button: string;
}

interface CardMessage {
  content_type?: string | null;
  content_text?: string | null;
  send_payload?: unknown;
}

export const isLinkCardMessage = (m: Pick<CardMessage, "content_type">): boolean => m.content_type === "link_card";

/**
 * What to draw for a link_card row. A row whose stored words are missing or damaged still draws: the title from `content_text`, no body, no button, and no
 * link id (so no status line and no actions).
 */
export function cardView(m: CardMessage): CardView {
  const stored = parseStoredCard(m.send_payload);
  if (stored) return { linkId: stored.link_id, title: stored.title || (m.content_text ?? ""), body: stored.body, button: stored.button };
  return { linkId: null, title: m.content_text ?? "", body: "", button: "" };
}

/** How many link cards a thread holds: the statuses are fetched again when this changes. */
export const countLinkCards = (messages: readonly CardMessage[]): number => messages.filter(isLinkCardMessage).length;

export interface CardActions {
  /** Send the form again (a new link; this one stops working). */
  resend: boolean;
  /** Withdraw the link. */
  withdraw: boolean;
}

/**
 * Which buttons the card shows. Both need the server's `canManage`. Withdraw only while the customer can still use the link. Send again whenever a new link
 * makes sense: not after the customer submitted it (the case moves on) and not for a link a newer one already replaced (that card has its own buttons).
 */
export function cardActions(status: Pick<CardStatus, "state" | "canManage" | "requestId"> | null | undefined): CardActions {
  if (!status || !status.canManage || !status.requestId) return { resend: false, withdraw: false };
  return {
    resend: status.state !== "submitted" && status.state !== "replaced",
    withdraw: isActiveCardState(status.state),
  };
}

/** The statuses by link id. */
export function indexStatuses(links: readonly CardStatus[]): ReadonlyMap<string, CardStatus> {
  return new Map(links.map((l) => [l.id, l]));
}
