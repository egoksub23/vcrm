/**
 * The mark Halo puts on mail it sends itself through a connected mailbox (Doc Sign: signing links, codes, signed documents), and how it is read back.
 *
 * Halo's inbox ingestion (the Gmail and Microsoft 365 webhooks) turns mail that arrives in a connected mailbox into conversations the whole team
 * can read. Mail Halo sent itself must never become one, so every such message carries `X-Halo-Sign: 1` and the ingestion paths refuse a message that
 * carries it, or that quotes one that did (a delivery-failure notice quotes the message it could not deliver).
 */

/** The header every Doc Sign message carries. */
export const HALO_SIGN_HEADER = 'X-Halo-Sign'
export const HALO_SIGN_VALUE = '1'

/** The header line as it reads inside a quoted original (a bounce): anywhere in the text, at the start of a line or after other text. */
const MARKER_IN_TEXT = new RegExp(`${HALO_SIGN_HEADER}:\\s*${HALO_SIGN_VALUE}\\b`, 'i')

/** True when `text` contains the Doc Sign header line (the original headers a delivery-failure notice carries). */
export function textCarriesMarker(text: string | null | undefined): boolean {
  return !!text && MARKER_IN_TEXT.test(text)
}
