/**
 * The mark Halo puts on mail it sends itself through a connected mailbox, and how it is read back.
 *
 * Halo's inbox ingestion (the Gmail and Microsoft 365 webhooks) turns mail that arrives in a connected mailbox into conversations the whole team
 * can read. Mail Halo sent itself must never become one. Two headers say "Halo sent this":
 *
 *   - `X-Halo-System: 1` on EVERY message Halo sends as the workspace through a mailbox (Secure Sign, team invitations, notifications, codes): added
 *     by the mailbox senders themselves (lib/email/ms365-sender.ts, gmail-sender.ts), so no caller can forget it;
 *   - `X-Halo-Sign: 1` as well on Secure Sign's own mail (its caller passes it), kept because mail already sent, and bounces of it, carry it.
 *
 * The ingestion paths refuse a message that carries either, or that quotes one that did (a delivery-failure notice quotes the message it could not
 * deliver).
 */

/** Carried by every message Halo sends itself through a mailbox. */
export const HALO_SYSTEM_HEADER = 'X-Halo-System'
export const HALO_SYSTEM_VALUE = '1'

/** Secure Sign's own mark, on top of the system one. */
export const HALO_SIGN_HEADER = 'X-Halo-Sign'
export const HALO_SIGN_VALUE = '1'

/** Every header that keeps a message out of the Inbox. */
export const HALO_MARKER_HEADERS: readonly string[] = [HALO_SYSTEM_HEADER, HALO_SIGN_HEADER]

/** The headers every message Halo sends through a mailbox carries, whoever sends it. */
export const HALO_SYSTEM_HEADERS: Record<string, string> = { [HALO_SYSTEM_HEADER]: HALO_SYSTEM_VALUE }

/** The header line as it reads inside a quoted original (a bounce): anywhere in the text, at the start of a line or after other text. */
const MARKER_IN_TEXT = new RegExp(`(?:${HALO_MARKER_HEADERS.join('|')}):\\s*(?:${HALO_SIGN_VALUE}|${HALO_SYSTEM_VALUE})\\b`, 'i')

/** True when `text` contains one of Halo's header lines (the original headers a delivery-failure notice carries). */
export function textCarriesMarker(text: string | null | undefined): boolean {
  return !!text && MARKER_IN_TEXT.test(text)
}

/** True when a header with this name is one of Halo's marks (any capitalisation). */
export function isMarkerHeaderName(name: string): boolean {
  const n = name.toLowerCase()
  return HALO_MARKER_HEADERS.some((h) => h.toLowerCase() === n)
}
