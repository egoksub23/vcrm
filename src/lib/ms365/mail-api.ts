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
 *   - `sendMailViaDraft` is the same new mail by another route, for files too
 *     big for one `sendMail` call: a draft, an upload session per file, then send.
 */

import { GraphApiError, throwGraphError } from './errors'
import { stripHtml } from '@/lib/email/strip-html'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

export interface GraphFileAttachment {
  name: string
  contentType: string
  /** Base64-encoded bytes. Graph's inline fileAttachment upload caps
   *  out around 3 MB this way — a message with more goes through
   *  `sendMailViaDraft` (draft + upload session) instead. */
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

/** What one new mail is made of; shared by the one-call route (`sendNewMail`) and the draft route (`sendMailViaDraft`). */
export interface SendNewMailArgs {
  accessToken: string
  toAddress: string
  subject: string
  text: string
  /** Rich-text body (the WYSIWYG composer's output) — sent as the
   *  message's HTML body when present, instead of `text`. `text` is
   *  still required as the value actually used when this is omitted. */
  html?: string
  attachment?: GraphFileAttachment
  /** More than one file (Doc Sign's signed copies); each is an inline fileAttachment, so together they stay under the inline limit. */
  attachments?: GraphFileAttachment[]
  /** Show this name next to the mailbox's own address (`from`). Left out, Exchange uses the mailbox's own name. */
  fromName?: string
  fromAddress?: string
  replyTo?: string
  /** Internet message headers (`X-...` names only: Graph refuses any other). Doc Sign writes `X-Halo-Sign: 1` here. */
  headers?: Record<string, string>
  /** Keep a copy in the mailbox's Sent Items. Defaults to true, as the inbox composer always did; Doc Sign turns it off. */
  saveToSentItems?: boolean
}

export async function sendNewMail(args: SendNewMailArgs): Promise<void> {
  const files =[...(args.attachment ? [args.attachment] : []), ...(args.attachments ?? [])]
  const headers = Object.entries(args.headers ?? {}).map(([name, value]) => ({ name, value }))
  const response = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: 'POST',
    headers: authHeaders(args.accessToken),
    body: JSON.stringify({
      message: {
        subject: args.subject,
        body: args.html
          ? { contentType: 'HTML', content: args.html }
          : { contentType: 'Text', content: args.text },
        toRecipients: [{ emailAddress: { address: args.toAddress } }],
        attachments: files.length ? files.map(attachmentPayload) : undefined,
        ...(args.fromAddress ? { from: { emailAddress: { address: args.fromAddress, ...(args.fromName ? { name: args.fromName } : {}) } } } : {}),
        ...(args.replyTo ? { replyTo: [{ emailAddress: { address: args.replyTo } }] } : {}),
        ...(headers.length ? { internetMessageHeaders: headers } : {}),
      },
      saveToSentItems: args.saveToSentItems ?? true,
    }),
  })
  if (!response.ok) {
    await throwGraphError(response, `sendMail failed: ${response.status}`)
  }
}

/**
 * One chunk of an upload session: a multiple of 320 KiB (Graph rejects any other size except the last chunk) and under the 4 MB Graph takes in one PUT.
 * 12 x 320 KiB = 3,840 KiB.
 */
export const UPLOAD_CHUNK_BYTES = 12 * 320 * 1024

/** How long to wait before each try at removing the sent copy: Exchange moves the mail from Drafts to Sent Items a moment after `send` answers. */
const PURGE_WAITS_MS = [1_500, 4_000, 8_000]

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface SendMailViaDraftArgs extends SendNewMailArgs {
  /** Waits between tries at removing the sent copy. Injected by tests. */
  sleep?: (ms: number) => Promise<void>
  /** The waits before each try at removing the sent copy (one try per entry). Injected by tests. */
  purgeWaitsMs?: number[]
}

/** Removes a message for good (it does not go through Deleted Items). Throws on any failure; callers that must not fail catch it. */
async function permanentlyDelete(accessToken: string, messageId: string): Promise<boolean> {
  const response = await fetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/permanentDelete`, {
    method: 'POST',
    headers: authHeaders(accessToken),
  })
  if (response.ok) return true
  // a token or a permission that does not cover this will not start to cover it a moment later
  if (response.status === 401 || response.status === 403) throw new GraphApiError(`permanentDelete failed: ${response.status}`, { httpStatus: response.status })
  return false
}

/**
 * Best effort: removes the copy `send` leaves in Sent Items. The message id is an immutable one (see `sendMailViaDraft`), so it still names the mail after Exchange
 * has moved it from Drafts to Sent Items, which happens a moment after `send` answers; hence the waits and the retries. Never throws; answers whether the copy
 * is gone.
 */
async function purgeSentCopy(accessToken: string, messageId: string, waitsMs: number[], sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (const wait of waitsMs) {
    try {
      await sleep(wait)
      if (await permanentlyDelete(accessToken, messageId)) return true
    } catch (err) {
      if (err instanceof GraphApiError && (err.httpStatus === 401 || err.httpStatus === 403)) return false
    }
  }
  return false
}

/** Puts one file on a draft through an upload session, in chunks (Graph's way for a file too big for the inline route). */
async function uploadAttachment(accessToken: string, messageId: string, file: GraphFileAttachment): Promise<void> {
  const bytes = Buffer.from(file.contentBytesBase64, 'base64')
  const sessionResponse = await fetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ AttachmentItem: { attachmentType: 'file', name: file.name, size: bytes.length, contentType: file.contentType } }),
  })
  if (!sessionResponse.ok) {
    await throwGraphError(sessionResponse, `createUploadSession failed: ${sessionResponse.status}`)
  }
  const session = (await sessionResponse.json()) as { uploadUrl?: string }
  if (!session.uploadUrl) throw new GraphApiError('createUploadSession answered without an upload address', { httpStatus: 502 })

  for (let start = 0; start < bytes.length; start += UPLOAD_CHUNK_BYTES) {
    const end = Math.min(start + UPLOAD_CHUNK_BYTES, bytes.length)
    // The upload address is already signed: it takes NO Authorization header (sending the access token there is refused).
    const response = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(end - start),
        'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}`,
      },
      body: new Uint8Array(bytes.buffer, bytes.byteOffset + start, end - start),
    })
    if (!response.ok) {
      await throwGraphError(response, `uploading ${file.name} failed: ${response.status}`)
    }
  }
}

/**
 * The route for a message whose files are too big for one `sendMail` call (about 3 MB for a file, about 4 MB for the call, and base64 adds a third):
 *   1. POST /me/messages                                  creates the draft (words, recipients, from, reply-to, headers; no files)
 *   2. POST /me/messages/{id}/attachments/createUploadSession, then PUT the bytes in chunks, for each file
 *   3. POST /me/messages/{id}/send
 * A failure part-way deletes the draft (best effort, for good) and is thrown as it came, for the caller to classify.
 *
 * `saveToSentItems: false` cannot be asked of `send` as it can of `sendMail`, so once `send` has answered the copy Exchange files in Sent Items is removed
 * with `permanentDelete`, best effort. That runs in the background: this function answers as soon as the mail is sent, and `purge` (which never rejects)
 * says later whether the copy is gone. If it could not be removed, a copy stays in the mailbox's Sent Items.
 *
 * The draft is asked for with `Prefer: IdType="ImmutableId"` so its id still names the mail after it moves from Drafts to Sent Items.
 */
export async function sendMailViaDraft(args: SendMailViaDraftArgs): Promise<{ purge: Promise<boolean> }> {
  const files = [...(args.attachment ? [args.attachment] : []), ...(args.attachments ?? [])]
  const headers = Object.entries(args.headers ?? {}).map(([name, value]) => ({ name, value }))
  const createResponse = await fetch(`${GRAPH_BASE}/me/messages`, {
    method: 'POST',
    headers: { ...authHeaders(args.accessToken), Prefer: 'IdType="ImmutableId"' },
    body: JSON.stringify({
      subject: args.subject,
      body: args.html ? { contentType: 'HTML', content: args.html } : { contentType: 'Text', content: args.text },
      toRecipients: [{ emailAddress: { address: args.toAddress } }],
      ...(args.fromAddress ? { from: { emailAddress: { address: args.fromAddress, ...(args.fromName ? { name: args.fromName } : {}) } } } : {}),
      ...(args.replyTo ? { replyTo: [{ emailAddress: { address: args.replyTo } }] } : {}),
      ...(headers.length ? { internetMessageHeaders: headers } : {}),
    }),
  })
  if (!createResponse.ok) {
    await throwGraphError(createResponse, `creating the draft failed: ${createResponse.status}`)
  }
  const draft = (await createResponse.json()) as { id?: string }
  if (!draft.id) throw new GraphApiError('creating the draft answered without a message id', { httpStatus: 502 })
  const draftId = draft.id

  try {
    for (const file of files) await uploadAttachment(args.accessToken, draftId, file)
    const sendResponse = await fetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(draftId)}/send`, {
      method: 'POST',
      headers: authHeaders(args.accessToken),
    })
    if (!sendResponse.ok) {
      await throwGraphError(sendResponse, `sending the draft failed: ${sendResponse.status}`)
    }
  } catch (err) {
    // do not leave a half-built draft (it may hold a signing link or a signed document) in the mailbox
    await permanentlyDelete(args.accessToken, draftId).catch(() => undefined)
    throw err
  }

  const purge =
    args.saveToSentItems === false
      ? purgeSentCopy(args.accessToken, draftId, args.purgeWaitsMs ?? PURGE_WAITS_MS, args.sleep ?? realSleep).catch(() => false)
      : Promise.resolve(true)
  return { purge }
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

/**
 * HTML-formatted reply (the WYSIWYG composer's output, quoted history
 * already appended). The one-call `reply` action's `comment` field has
 * no reliable way to carry real HTML formatting, so this uses the same
 * createReply -> [attach] -> send dance as `sendReplyWithAttachment`,
 * but PATCHes the draft's body to our own HTML instead of passing
 * `comment` on creation — we already built the full quoted-history
 * block client-side, so Graph's own auto-quoted draft body is
 * overwritten rather than appended to.
 */
export async function sendReplyHtml(args: {
  accessToken: string
  replyToMessageId: string
  html: string
  attachment?: GraphFileAttachment
}): Promise<void> {
  const createResponse = await fetch(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(args.replyToMessageId)}/createReply`,
    { method: 'POST', headers: authHeaders(args.accessToken), body: JSON.stringify({}) },
  )
  if (!createResponse.ok) {
    await throwGraphError(createResponse, `createReply failed: ${createResponse.status}`)
  }
  const draft = (await createResponse.json()) as { id: string }

  const patchResponse = await fetch(`${GRAPH_BASE}/me/messages/${encodeURIComponent(draft.id)}`, {
    method: 'PATCH',
    headers: authHeaders(args.accessToken),
    body: JSON.stringify({ body: { contentType: 'HTML', content: args.html } }),
  })
  if (!patchResponse.ok) {
    await throwGraphError(patchResponse, `updating reply draft body failed: ${patchResponse.status}`)
  }

  if (args.attachment) {
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
  /** The `sender` (who actually sent it, which can differ from `from`), when Graph gave one. */
  senderAddress: string | null
  /** The internet message headers, as Graph returns them (name and value). Empty when Graph returned none. */
  headers: { name: string; value: string }[]
}

export async function getMessage(args: {
  accessToken: string
  messageId: string
}): Promise<GraphMessageSummary> {
  const params = new URLSearchParams({
    $select: 'id,subject,from,sender,body,hasAttachments,receivedDateTime,internetMessageHeaders',
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
    sender?: { emailAddress?: { address?: string } }
    body?: { contentType?: string; content?: string }
    hasAttachments?: boolean
    receivedDateTime: string
    internetMessageHeaders?: { name?: string; value?: string }[]
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
    senderAddress: data.sender?.emailAddress?.address ?? null,
    headers: (data.internetMessageHeaders ?? []).flatMap((h) => (h.name ? [{ name: h.name, value: h.value ?? '' }] : [])),
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
 *  just because Graph's side 404s (already expired/deleted). Never throws.
 *  Answers whether Graph confirmed the subscription is gone (a 2xx, or a
 *  404 because it was already gone), for callers that report it (switching
 *  the customer care inbox off); `false` means it may still be alive and
 *  will lapse by itself within the subscription's lifetime (about 3 days). */
export async function deleteSubscription(args: {
  accessToken: string
  subscriptionId: string
}): Promise<boolean> {
  try {
    const response = await fetch(`${GRAPH_BASE}/subscriptions/${encodeURIComponent(args.subscriptionId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${args.accessToken}` },
    })
    return response.ok || response.status === 404
  } catch {
    return false
  }
}
