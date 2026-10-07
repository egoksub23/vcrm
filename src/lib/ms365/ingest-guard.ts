/**
 * What Halo's Microsoft 365 inbox ingestion must never turn into a conversation.
 *
 * The inbox is shared: every agent with inbox access reads every conversation. Mail Halo itself sends through the connected mailbox (Doc Sign: signing
 * links, verification codes, signed documents) is not filed in the Inbox, with one exception: a message addressed to the mailbox itself (a test email,
 * a copy to the sender's own address) is delivered to its Inbox like any other, and a delivery-failure notice for a message Halo sent arrives there
 * too. The change-notification webhook reads every message created in the Inbox, so without a guard those would be stored as a customer's message.
 *
 * Signals, any one of which keeps a message out:
 *   1. the header `X-Halo-Sign: 1` that Doc Sign writes on every message it sends (`internetMessageHeaders`);
 *   2. the same header line inside a delivery-failure notice's body, where Exchange quotes the original's headers;
 *   3. the sender, or the `from`, being the connected mailbox itself (the older rule, now also on `sender`).
 */

import { HALO_SIGN_HEADER, textCarriesMarker } from '@/lib/email/halo-mail-marker'

export interface Ms365IngestCandidate {
  fromAddress: string | null
  senderAddress: string | null
  headers: readonly { name: string; value: string }[]
  /** The message body as text: where a delivery-failure notice quotes the headers of what it could not deliver. */
  bodyText: string | null
  bodyHtml: string | null
}

export type Ms365IngestDecision = { ingest: true } | { ingest: false; reason: 'no_sender' | 'sent_by_mailbox' | 'doc_sign' }

/** True when the message, or the original a delivery-failure notice quotes, carries the Doc Sign header. */
export function isHaloSignMessage(m: Pick<Ms365IngestCandidate, 'headers' | 'bodyText' | 'bodyHtml'>): boolean {
  if (m.headers.some((h) => h.name.toLowerCase() === HALO_SIGN_HEADER.toLowerCase())) return true
  return textCarriesMarker(m.bodyText) || textCarriesMarker(m.bodyHtml)
}

/** Whether a message that was created in the mailbox's Inbox may become a conversation. */
export function decideMs365Ingest(message: Ms365IngestCandidate, mailboxAddress: string): Ms365IngestDecision {
  if (isHaloSignMessage(message)) return { ingest: false, reason: 'doc_sign' }
  if (!message.fromAddress) return { ingest: false, reason: 'no_sender' }
  const mailbox = mailboxAddress.toLowerCase()
  if (message.fromAddress.toLowerCase() === mailbox || message.senderAddress?.toLowerCase() === mailbox) return { ingest: false, reason: 'sent_by_mailbox' }
  return { ingest: true }
}
