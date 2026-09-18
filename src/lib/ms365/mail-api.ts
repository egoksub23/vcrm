/**
 * Microsoft Graph mail helpers — send, fetch, attachments, and change-
 * notification subscriptions. Named-params-object convention, matching
 * `src/lib/whatsapp/meta-api.ts` / `src/lib/messenger/meta-api.ts`.
 *
 * Sending deliberately has two shapes, chosen by the send path
 * (`src/lib/whatsapp/send-message.ts`) based on whether there's a prior
 * inbound message to reply to:
 *   - A true reply (`POST /messages/{id}/reply` or, for an attachment,
 *     `createReply` -> attach -> `send`) threads into the customer's own
 *     Outlook conversation the way a human hitting "Reply" would —
 *     there is no equivalent in the chat-style channels, but it matters
 *     a lot for email, where customers expect their client to group a
 *     support thread.
 *   - `sendNewMail` (`POST /me/sendMail`) is the fallback for the first
 *     outbound message in a conversation (an agent proactively emailing
 *     a contact who hasn't written in yet — no prior message to reply to).
 */

import { throwGraphError } from './errors'
import { stripHtml } from '@/lib/email/strip-html'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

export interface GraphFileAttachment {
  name: string
  contentType: string
  /** Base64-encoded bytes. Graph's inline fileAttachment upload caps
   *  out around 3 MB this way — larger files need an upload session,
   *  out of v1 scope (see docs/microsoft-365-email-setup.md). */
  contentBytesBase64: string
}

function attachmentPayload(attachment: GraphFileAttachment) {
  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: attachment.name,
    contentType: attachment.contentType,
    contentBytes: attachment.contentBytesBase64,
  }
}

export async function sendNewMail(args: {
  accessToken: string
  toAddress: string
  subject: string
  text: string
  attachment?: GraphFileAttachment
}): Promise<void> {
  const response = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: 'POST',
    headers: authHeaders(args.accessToken),
    body: JSON.stringify({
      message: {
        subject: args.subject,
        body: { contentType: 'Text', content: args.text },
        toRecipients: [{ emailAddress: { address: args.toAddress } }],
        attachments: args.attachment ? [attachmentPayload(args.attachment)] : undefined,
      },
      saveToSentItems: true,
    }),
  })
  if (!response.ok) {
    await throwGraphError(response, `sendMail failed: ${response.status}`)
  }
}

export async function sendReplyText(args: {
  accessToken: string
  replyToMessageId: string
  text: string
}): Promise<void> {
  const response = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(args.replyToMessageId)}/reply`,
    {
      method: 'POST',
      headers: authHeaders(args.accessToken),
      body: JSON.stringify({ comment: args.text }),
    },
  )
  if (!response.ok) {
    await throwGraphError(response, `reply failed: ${response.status}`)
  }
}

/**
 * Reply action has no single-call attachment support — a threaded
 * reply carrying an attachment needs the three-call createReply ->
 * attach -> send dance instead of the one-call `reply` action above.
 */
export async function sendReplyWithAttachment(args: {
  accessToken: string
  replyToMessageId: string
  text: string
  attachment: GraphFileAttachment
}): Promise<void> {
  const createResponse = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(args.replyToMessageId)}/createReply`,
    {
      method: 'POST',
      headers: authHeaders(args.accessToken),
      body: JSON.stringify({ comment: args.text }),
    },
  )
  if (!createResponse.ok) {
    await throwGraphError(createResponse, `createReply failed: ${createResponse.status}`)
  }
  const draft = (await createResponse.json()) as { id: string }

  const attachResponse = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(draft.id)}/attachments`,
    {
      method: 'POST',
      headers: authHeaders(args.accessToken),
      body: JSON.stringify(attachmentPayload(args.attachment)),
    },
  )
  if (!attachResponse.ok) {
    await throwGraphError(attachResponse, `attaching to reply draft failed: ${attachResponse.status}`)
  }

  const sendResponse = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(draft.id)}/send`,
    { method: 'POST', headers: authHeaders(args.accessToken) },
  )
  if (!sendResponse.ok) {
    await throwGraphError(sendResponse, `sending reply draft failed: ${sendResponse.status}`)
  }
}

export interface GraphMessageSummary {
  id: string
  subject: string | null
  fromAddress: string | null
  fromName: string | null
  /** Plain text — Graph's own content when the message was plain-text
   *  to begin with, otherwise derived from `bodyHtml` via `stripHtml`. */
  bodyText: string | null
  /** Raw HTML body, unstripped — null when the message was genuinely
   *  plain-text. Rendered client-side, never trusted as-is (see
   *  EmailHtmlView). */
  bodyHtml: string | null
  hasAttachments: boolean
  receivedDateTime: string
}

export async function getMessage(args: {
  accessToken: string
  messageId: string
}): Promise<GraphMessageSummary> {
  const params = new URLSearchParams({
    $select: 'id,subject,from,body,hasAttachments,receivedDateTime',
  })
  const response = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(args.messageId)}?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        // No `Prefer: outlook.body-content-type="text"` here — that
        // would make Graph render body.content as plain text and throw
        // away the original HTML we want for the rendered view. Fetch
        // the native format instead (almost always HTML for a real
        // email) and derive the plain-text fallback ourselves below.
      },
    },
  )
  if (!response.ok) {
    await throwGraphError(response, `getMessage failed: ${response.status}`)
  }
  const data = (await response.json()) as {
    id: string
    subject?: string
    from?: { emailAddress?: { address?: string; name?: string } }
    body?: { contentType?: string; content?: string }
    hasAttachments?: boolean
    receivedDateTime: string
  }
  const isHtml = data.body?.contentType?.toLowerCase() === 'html'
  const rawContent = data.body?.content ?? null
  return {
    id: data.id,
    subject: data.subject ?? null,
    fromAddress: data.from?.emailAddress?.address ?? null,
    fromName: data.from?.emailAddress?.name ?? null,
    bodyText: rawContent === null ? null : isHtml ? stripHtml(rawContent) : rawContent,
    bodyHtml: isHtml ? rawContent : null,
    hasAttachments: data.hasAttachments ?? false,
    receivedDateTime: data.receivedDateTime,
  }
}

export interface GraphAttachmentSummary {
  id: string
  name: string
  contentType: string
  size: number
}

export async function listAttachments(args: {
  accessToken: string
  messageId: string
}): Promise<GraphAttachmentSummary[]> {
  const params = new URLSearchParams({ $select: 'id,name,contentType,size' })
  const response = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(args.messageId)}/attachments?${params.toString()}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
  )
  if (!response.ok) {
    await throwGraphError(response, `listAttachments failed: ${response.status}`)
  }
  const data = (await response.json()) as { value: GraphAttachmentSummary[] }
  return data.value ?? []
}

/**
 * Fetches one attachment's bytes inline (base64 in the JSON payload) —
 * fine up to Graph's ~3 MB inline limit, which covers the vast majority
 * of email attachments. Larger files would need Graph's chunked
 * upload-session APIs; out of v1 scope.
 */
export async function downloadAttachmentBytes(args: {
  accessToken: string
  messageId: string
  attachmentId: string
}): Promise<{ bytes: Buffer; contentType: string; name: string } | null> {
  const response = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(args.messageId)}/attachments/${encodeURIComponent(args.attachmentId)}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
  )
  if (!response.ok) return null
  const data = (await response.json()) as {
    name: string
    contentType?: string
    contentBytes?: string
  }
  if (!data.contentBytes) return null
  return {
    bytes: Buffer.from(data.contentBytes, 'base64'),
    contentType: data.contentType || 'application/octet-stream',
    name: data.name,
  }
}

export interface GraphSubscription {
  id: string
  expirationDateTime: string
}

// Graph's documented max for mail resources is 4230 minutes (~2.94
// days); staying a little under that leaves slack against clock skew
// between this server and Graph's.
const SUBSCRIPTION_MINUTES = 4200

export async function createSubscription(args: {
  accessToken: string
  notificationUrl: string
  clientState: string
}): Promise<GraphSubscription> {
  const expirationDateTime = new Date(Date.now() + SUBSCRIPTION_MINUTES * 60 * 1000).toISOString()
  const response = await fetch(`${GRAPH_BASE}/subscriptions`, {
    method: 'POST',
    headers: authHeaders(args.accessToken),
    body: JSON.stringify({
      changeType: 'created',
      notificationUrl: args.notificationUrl,
      // Scoped to the Inbox folder only — an agent's own outbound
      // replies land in Sent Items, never the Inbox, so (unlike
      // Messenger/Instagram's is_echo problem) our own sends simply
      // never generate a notification here. No echo-filtering needed.
      resource: `me/mailFolders('inbox')/messages`,
      expirationDateTime,
      clientState: args.clientState,
    }),
  })
  if (!response.ok) {
    await throwGraphError(response, `createSubscription failed: ${response.status}`)
  }
  const data = (await response.json()) as GraphSubscription
  return data
}

export async function renewSubscription(args: {
  accessToken: string
  subscriptionId: string
}): Promise<GraphSubscription> {
  const expirationDateTime = new Date(Date.now() + SUBSCRIPTION_MINUTES * 60 * 1000).toISOString()
  const response = await fetch(`${GRAPH_BASE}/subscriptions/${encodeURIComponent(args.subscriptionId)}`, {
    method: 'PATCH',
    headers: authHeaders(args.accessToken),
    body: JSON.stringify({ expirationDateTime }),
  })
  if (!response.ok) {
    await throwGraphError(response, `renewSubscription failed: ${response.status}`)
  }
  const data = (await response.json()) as GraphSubscription
  return data
}

/** Best-effort — callers (disconnect) don't fail the local operation
 *  just because Graph's side 404s (already expired/deleted). */
export async function deleteSubscription(args: {
  accessToken: string
  subscriptionId: string
}): Promise<void> {
  await fetch(`${GRAPH_BASE}/subscriptions/${encodeURIComponent(args.subscriptionId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${args.accessToken}` },
  }).catch(() => undefined)
}
