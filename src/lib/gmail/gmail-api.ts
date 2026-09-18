/**
 * Gmail API helpers — send, fetch, attachments, watch (push
 * notification registration), and incremental history sync.
 * Named-params-object convention, matching every other channel's API
 * wrapper in this codebase.
 */

import { throwGmailError } from './errors'
import {
  buildRawMessage,
  decodeBase64Url,
  findAttachmentParts,
  findTextBody,
  getHeader,
  parseFromHeader,
  type GmailAttachmentPart,
  type GmailPayloadPart,
} from './mime'

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

interface SendResponse {
  id: string
  threadId: string
}

async function send(args: {
  accessToken: string
  raw: string
  threadId?: string
}): Promise<SendResponse> {
  const response = await fetch(`${GMAIL_API_BASE}/messages/send`, {
    method: 'POST',
    headers: authHeaders(args.accessToken),
    body: JSON.stringify({ raw: args.raw, threadId: args.threadId }),
  })
  if (!response.ok) {
    await throwGmailError(response, `messages.send failed: ${response.status}`)
  }
  return (await response.json()) as SendResponse
}

export interface GmailAttachmentInput {
  name: string
  contentType: string
  contentBytesBase64: string
}

export async function sendNewMail(args: {
  accessToken: string
  toAddress: string
  subject: string
  text: string
  attachment?: GmailAttachmentInput
}): Promise<{ messageId: string }> {
  const raw = buildRawMessage({
    toAddress: args.toAddress,
    subject: args.subject,
    text: args.text,
    attachment: args.attachment,
  })
  const result = await send({ accessToken: args.accessToken, raw })
  return { messageId: result.id }
}

export async function sendReply(args: {
  accessToken: string
  threadId: string
  /** RFC822 `Message-ID` header of the message being replied to — from
   *  `getThreadingInfo` below. */
  inReplyToMessageId: string | null
  toAddress: string
  subject: string
  text: string
  attachment?: GmailAttachmentInput
}): Promise<{ messageId: string }> {
  const raw = buildRawMessage({
    toAddress: args.toAddress,
    subject: args.subject,
    text: args.text,
    inReplyTo: args.inReplyToMessageId ?? undefined,
    references: args.inReplyToMessageId ?? undefined,
    attachment: args.attachment,
  })
  const result = await send({ accessToken: args.accessToken, raw, threadId: args.threadId })
  return { messageId: result.id }
}

export interface GmailThreadingInfo {
  threadId: string
  /** RFC822 `Message-ID` header — distinct from Gmail's own internal
   *  `id`, and what `In-Reply-To`/`References` need for real email
   *  threading. Null on the rare message that lacks the header. */
  rfc822MessageId: string | null
  subject: string | null
}

/** Fetched fresh at reply time rather than cached on the `messages`
 *  row — one extra API call, but avoids a schema change for data only
 *  needed at the moment of replying. */
export async function getThreadingInfo(args: {
  accessToken: string
  messageId: string
}): Promise<GmailThreadingInfo> {
  const params = new URLSearchParams({ format: 'metadata' })
  params.append('metadataHeaders', 'Message-ID')
  params.append('metadataHeaders', 'Subject')
  const response = await fetch(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(args.messageId)}?${params.toString()}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
  )
  if (!response.ok) {
    await throwGmailError(response, `getThreadingInfo failed: ${response.status}`)
  }
  const data = (await response.json()) as { threadId: string; payload?: { headers?: GmailPayloadPart['headers'] } }
  return {
    threadId: data.threadId,
    rfc822MessageId: getHeader(data.payload?.headers, 'Message-ID'),
    subject: getHeader(data.payload?.headers, 'Subject'),
  }
}

export interface GmailMessageSummary {
  id: string
  threadId: string
  subject: string | null
  fromAddress: string | null
  fromName: string | null
  bodyText: string | null
  attachments: GmailAttachmentPart[]
  /** Gmail's own send/receive timestamp, epoch milliseconds as a string. */
  internalDate: string
}

export async function getMessage(args: {
  accessToken: string
  messageId: string
}): Promise<GmailMessageSummary> {
  const response = await fetch(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(args.messageId)}?format=full`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
  )
  if (!response.ok) {
    await throwGmailError(response, `getMessage failed: ${response.status}`)
  }
  const data = (await response.json()) as {
    id: string
    threadId: string
    internalDate: string
    payload?: GmailPayloadPart
  }
  const { name, address } = parseFromHeader(getHeader(data.payload?.headers, 'From'))
  return {
    id: data.id,
    threadId: data.threadId,
    subject: getHeader(data.payload?.headers, 'Subject'),
    fromAddress: address,
    fromName: name,
    bodyText: findTextBody(data.payload),
    attachments: findAttachmentParts(data.payload),
    internalDate: data.internalDate,
  }
}

/** Inline attachment bytes, base64url in the JSON payload — same
 *  ~size-limited-but-fine-for-most-attachments approach as the
 *  Microsoft 365 channel's `downloadAttachmentBytes`. */
export async function downloadAttachmentBytes(args: {
  accessToken: string
  messageId: string
  attachmentId: string
}): Promise<Buffer | null> {
  const response = await fetch(
    `${GMAIL_API_BASE}/messages/${encodeURIComponent(args.messageId)}/attachments/${encodeURIComponent(args.attachmentId)}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
  )
  if (!response.ok) return null
  const data = (await response.json()) as { data?: string }
  if (!data.data) return null
  return decodeBase64Url(data.data)
}

export interface GmailWatchResult {
  historyId: string
  /** ISO timestamp — Gmail returns epoch milliseconds as a string. */
  expiration: string
}

/** Registers (or renews) push notifications to the Pub/Sub topic the
 *  operator set up (GMAIL_PUBSUB_TOPIC — see docs/gmail-setup.md).
 *  Scoped to the INBOX label only, same "our own sends never trigger
 *  it" isolation the Microsoft 365 channel's Inbox-folder-scoped
 *  subscription gets — a plain send never adds the INBOX label. */
export async function watchMailbox(args: {
  accessToken: string
  topicName: string
}): Promise<GmailWatchResult> {
  const response = await fetch(`${GMAIL_API_BASE}/watch`, {
    method: 'POST',
    headers: authHeaders(args.accessToken),
    body: JSON.stringify({ topicName: args.topicName, labelIds: ['INBOX'], labelFilterAction: 'include' }),
  })
  if (!response.ok) {
    await throwGmailError(response, `watch failed: ${response.status}`)
  }
  const data = (await response.json()) as { historyId: string; expiration: string }
  return { historyId: data.historyId, expiration: new Date(Number(data.expiration)).toISOString() }
}

/** Best-effort — callers (disconnect) don't fail the local operation
 *  just because Google's side already lapsed. */
export async function stopWatch(args: { accessToken: string }): Promise<void> {
  await fetch(`${GMAIL_API_BASE}/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.accessToken}` },
  }).catch(() => undefined)
}

export async function getCurrentHistoryId(args: { accessToken: string }): Promise<string> {
  const response = await fetch(`${GMAIL_API_BASE}/profile`, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  })
  if (!response.ok) {
    await throwGmailError(response, `getProfile failed: ${response.status}`)
  }
  const data = (await response.json()) as { historyId: string }
  return data.historyId
}

export interface GmailHistoryResult {
  /** Gmail message ids newly added to INBOX since `startHistoryId`. */
  newMessageIds: string[]
  latestHistoryId: string
  /** True when `startHistoryId` was too old for Gmail to still have a
   *  history record for (retention is limited, roughly a week) —
   *  callers should re-baseline via `getCurrentHistoryId` and accept
   *  the gap rather than retrying the same startHistoryId forever. */
  historyExpired: boolean
}

const MAX_HISTORY_PAGES = 5

export async function listHistory(args: {
  accessToken: string
  startHistoryId: string
}): Promise<GmailHistoryResult> {
  const newMessageIds = new Set<string>()
  let pageToken: string | undefined
  let latestHistoryId = args.startHistoryId
  let pages = 0

  do {
    const params = new URLSearchParams({
      startHistoryId: args.startHistoryId,
      historyTypes: 'messageAdded',
      labelId: 'INBOX',
    })
    if (pageToken) params.set('pageToken', pageToken)

    const response = await fetch(`${GMAIL_API_BASE}/history?${params.toString()}`, {
      headers: { Authorization: `Bearer ${args.accessToken}` },
    })
    if (response.status === 404) {
      return { newMessageIds: [], latestHistoryId: args.startHistoryId, historyExpired: true }
    }
    if (!response.ok) {
      await throwGmailError(response, `history.list failed: ${response.status}`)
    }
    const data = (await response.json()) as {
      history?: { messagesAdded?: { message?: { id?: string } }[] }[]
      historyId?: string
      nextPageToken?: string
    }
    for (const entry of data.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        if (added.message?.id) newMessageIds.add(added.message.id)
      }
    }
    if (data.historyId) latestHistoryId = data.historyId
    pageToken = data.nextPageToken
    pages++
  } while (pageToken && pages < MAX_HISTORY_PAGES)

  return { newMessageIds: Array.from(newMessageIds), latestHistoryId, historyExpired: false }
}
