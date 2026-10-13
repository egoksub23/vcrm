// ============================================================
// Compliance requests, the personal closure form link (migration 185): the states a link is in, as one pure function. No I/O and no Node imports, so the
// case page, the Inbox card and the server share it.
//
//   created    minted but not sent in a chat (the agent copied it, or the send failed)
//   sent       delivered to the chat
//   opened     the customer opened the page
//   submitted  the customer filled it in (the link is used up)
//   expired    past its expiry without being used
//   revoked    an agent withdrew it
//   replaced   a newer link was made for the same request, so this one stopped working
//
// "Active" means the link can still be used: not submitted, not revoked, not expired. A submitted link is the end of it; the other three end states can be
// followed by a new link (the resend).
// ============================================================

export const LINK_STATES = ["created", "sent", "opened", "submitted", "expired", "revoked", "replaced"] as const;
export type LinkState = (typeof LINK_STATES)[number];

/** How long a personal link works (days). */
export const LINK_TTL_DAYS = 14;
export const LINK_TTL_MIN_DAYS = 1;
export const LINK_TTL_MAX_DAYS = 30;

export interface LinkTimes {
  created_at?: string | null;
  expires_at: string;
  sent_at: string | null;
  opened_at: string | null;
  submitted_at: string | null;
  revoked_at: string | null;
  /** 'replaced' when a newer link took over; 'revoked' when an agent withdrew it. */
  revoked_reason?: string | null;
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** The state of a link at `now`. Submitted wins over everything (it happened), then revoked or replaced, then expiry, then how far it got. */
export function linkState(l: LinkTimes, now: Date = new Date()): LinkState {
  if (l.submitted_at) return "submitted";
  if (l.revoked_at) return l.revoked_reason === "replaced" ? "replaced" : "revoked";
  const exp = ms(l.expires_at);
  if (Number.isFinite(exp) && exp <= now.getTime()) return "expired";
  if (l.opened_at) return "opened";
  if (l.sent_at) return "sent";
  return "created";
}

/** Can the customer still use it? */
export const isActiveLink = (l: LinkTimes, now: Date = new Date()): boolean => {
  const s = linkState(l, now);
  return s === "created" || s === "sent" || s === "opened";
};

/** May an agent send a new one? (Not after the form was filled in: the answers are on the case; the officer edits them there.) */
export const canSendAnother = (state: LinkState): boolean => state !== "submitted";

/** May an agent withdraw it? Only while it can still be used. */
export const canRevoke = (state: LinkState): boolean => state === "created" || state === "sent" || state === "opened";

/** The expiry for a link made at `now`: `days` later, between 1 and 30. */
export function expiryFor(now: Date, days: number = LINK_TTL_DAYS): Date {
  const d = Math.min(LINK_TTL_MAX_DAYS, Math.max(LINK_TTL_MIN_DAYS, Math.floor(Number.isFinite(days) ? days : LINK_TTL_DAYS)));
  return new Date(now.getTime() + d * 86_400_000);
}
