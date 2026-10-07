/**
 * What Halo's Gmail inbox ingestion must never turn into a conversation.
 *
 * The inbox is shared: every agent with inbox access reads every conversation. Mail that Halo itself sends through the connected mailbox
 * (Doc Sign: signing links, verification codes, signed documents) lands in that mailbox's Sent folder, and Gmail files a message addressed to
 * the mailbox itself (a test email, a copy to the sender's own address) in the INBOX as well. The push webhook reads INBOX additions, so
 * without a guard those messages would be read, stored as a customer's message and shown to the whole team.
 *
 * Three independent signals, any one of which keeps a message out:
 *   1. the label SENT: Gmail's own statement that the mailbox sent it (never true of a message somebody else sent us);
 *   2. the header `X-Halo-Sign: 1` that Doc Sign writes on every message it sends, also found inside the original that a delivery-failure
 *      notice carries back, so the bounce of a signing mail is not ingested either;
 *   3. the sender being the connected mailbox itself (the older rule).
 */

import { HALO_SIGN_HEADER, textCarriesMarker } from '@/lib/email/halo-mail-marker'

import { decodeBase64Url, getHeader, type GmailPayloadPart } from './mime'

/** Parts that hold an original message's headers (a bounce quotes the message it could not deliver). */
const QUOTED_ORIGINAL = new Set(['message/rfc822', 'text/rfc822-headers'])

/** True when the message, or the original a delivery-failure notice quotes, carries the Doc Sign header. */
export function isHaloSignMessage(payload: GmailPayloadPart | undefined): boolean {
  if (!payload) return false
  if (getHeader(payload.headers, HALO_SIGN_HEADER) !== null) return true
  if (payload.mimeType && QUOTED_ORIGINAL.has(payload.mimeType) && payload.body?.data) {
    try {
      if (textCarriesMarker(decodeBase64Url(payload.body.data).toString('utf-8'))) return true
    } catch {
      // not decodable: it cannot carry the marker we can read
    }
  }
  return (payload.parts ?? []).some(isHaloSignMessage)
}

export interface IngestCandidate {
  fromAddress: string | null
  /** Gmail's labels on the message (`INBOX`, `SENT`, ...). */
  labelIds: readonly string[]
  /** `isHaloSignMessage` of the fetched message. */
  haloSign: boolean
}

export type IngestDecision = { ingest: true } | { ingest: false; reason: 'no_sender' | 'sent_by_mailbox' | 'sent_label' | 'doc_sign' }

/** Whether a message that appeared in the mailbox's INBOX may become a conversation. */
export function decideIngest(message: IngestCandidate, mailboxAddress: string): IngestDecision {
  if (message.haloSign) return { ingest: false, reason: 'doc_sign' }
  if (message.labelIds.includes('SENT')) return { ingest: false, reason: 'sent_label' }
  if (!message.fromAddress) return { ingest: false, reason: 'no_sender' }
  if (message.fromAddress.toLowerCase() === mailboxAddress.toLowerCase()) return { ingest: false, reason: 'sent_by_mailbox' }
  return { ingest: true }
}
