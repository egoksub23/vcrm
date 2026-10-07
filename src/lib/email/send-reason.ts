/**
 * Why an email did not go, as a short machine word the screens can say in the reader's language.
 *
 * A delivery that failed carries one string, `detail`: `<reason>` or `<reason>: <what the mail service said>`, or only what the service said when
 * the failure is not one we recognise. The words below are the reasons we do recognise. This file has no server-only imports: the screens
 * that show a reason read it too.
 */

export const SEND_REASONS = [
  /** No connected mailbox and no platform sender: nothing can send. */
  "not_set_up",
  /** The connected Gmail access was revoked or has expired: someone has to reconnect it. */
  "mailbox_reconnect",
  /** The connected mailbox is switched off in Settings > Channels. */
  "mailbox_paused",
  /** Gmail's sending limit for the day is used up. */
  "daily_limit",
  /** Gmail asked for fewer messages per second; trying again in a moment works. */
  "rate_limited",
  /** The recipient's address was refused. */
  "address_rejected",
  /** The message with its files is too large for the mail service. */
  "attachment_too_large",
  /** The mail service could not be reached or had an error of its own. */
  "service_unavailable",
] as const;

export type SendReason = (typeof SEND_REASONS)[number];

const KNOWN = new Set<string>(SEND_REASONS);

export function isSendReason(value: unknown): value is SendReason {
  return typeof value === "string" && KNOWN.has(value);
}

/** The `detail` of a failed delivery: the reason, then (shortened) what the mail service said. */
export function reasonDetail(reason: SendReason | null, technical?: string | null): string {
  const said = (technical ?? "").replace(/\s+/g, " ").trim();
  if (!reason) return said.slice(0, 200) || "send failed";
  return (said ? `${reason}: ${said}` : reason).slice(0, 200);
}

/** The reason a `detail` starts with, or null when it is only free text. */
export function reasonOfDetail(detail: string | null | undefined): SendReason | null {
  if (!detail) return null;
  const head = /^([a-z_]+)(?::|$)/.exec(detail.trim())?.[1];
  return head && isSendReason(head) ? head : null;
}

/** What the mail service said, without the leading reason word. */
export function technicalOfDetail(detail: string | null | undefined): string {
  if (!detail) return "";
  const reason = reasonOfDetail(detail);
  if (!reason) return detail.trim();
  return detail.trim().slice(reason.length).replace(/^:\s*/, "");
}

/** A send that failed for a reason we can name (or one we cannot: `reason` is then null and the message is the service's own words). */
export class MailSendError extends Error {
  readonly reason: SendReason | null;
  readonly technical: string;

  constructor(reason: SendReason | null, technical = "") {
    super(reasonDetail(reason, technical));
    this.name = "MailSendError";
    this.reason = reason;
    this.technical = technical;
  }
}
