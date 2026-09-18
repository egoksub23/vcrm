/**
 * RFC 822 message building (for sends) and Gmail API payload walking
 * (for reads). Gmail's send API takes a raw base64url-encoded email
 * rather than Graph's structured JSON body, and its read API returns a
 * MIME multipart tree rather than a single pre-rendered plain-text
 * field the way Graph's `Prefer: outlook.body-content-type="text"`
 * header gives — both are genuinely new shapes in this codebase, kept
 * in one small file rather than scattered across gmail-api.ts.
 */

export interface GmailHeader {
  name: string
  value: string
}

export interface GmailPayloadPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { attachmentId?: string; size?: number; data?: string }
  parts?: GmailPayloadPart[]
}

function encodeMimeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`
}

export interface OutgoingMailArgs {
  toAddress: string
  subject: string
  text: string
  /** RFC822 `Message-ID` header of the message being replied to, e.g.
   *  `<abc123@mail.gmail.com>` — set together for a threaded reply. */
  inReplyTo?: string
  references?: string
  attachment?: { name: string; contentType: string; contentBytesBase64: string }
}

/** Builds the base64url-encoded raw message `users.messages.send` expects. */
export function buildRawMessage(args: OutgoingMailArgs): string {
  const boundary = `part_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const headers: string[] = [
    `To: ${args.toAddress}`,
    `Subject: ${encodeMimeHeader(args.subject)}`,
    'MIME-Version: 1.0',
  ]
  if (args.inReplyTo) headers.push(`In-Reply-To: ${args.inReplyTo}`)
  if (args.references) headers.push(`References: ${args.references}`)

  let body: string
  if (args.attachment) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      args.text,
      `--${boundary}`,
      `Content-Type: ${args.attachment.contentType}; name="${args.attachment.name}"`,
      `Content-Disposition: attachment; filename="${args.attachment.name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      args.attachment.contentBytesBase64,
      `--${boundary}--`,
    ].join('\r\n')
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"')
    body = args.text
  }

  const raw = `${headers.join('\r\n')}\r\n\r\n${body}`
  return Buffer.from(raw, 'utf-8').toString('base64url')
}

export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data, 'base64url')
}

export function getHeader(headers: GmailHeader[] | undefined, name: string): string | null {
  const found = headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return found?.value ?? null
}

/** Crude HTML→text fallback for a message with no text/plain part —
 *  good enough for CRM display, not a full renderer. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Walks the payload tree depth-first for the best available body text
 * — prefers a `text/plain` part, falls back to `text/html` (stripped).
 * Returns null if neither is present (e.g. an attachment-only message).
 */
export function findTextBody(payload: GmailPayloadPart | undefined): string | null {
  if (!payload) return null

  let plainFallback: string | null = null
  let htmlFallback: string | null = null

  function walk(part: GmailPayloadPart) {
    if (part.mimeType === 'text/plain' && part.body?.data && plainFallback === null) {
      plainFallback = decodeBase64Url(part.body.data).toString('utf-8')
    } else if (part.mimeType === 'text/html' && part.body?.data && htmlFallback === null) {
      htmlFallback = decodeBase64Url(part.body.data).toString('utf-8')
    }
    for (const child of part.parts ?? []) walk(child)
  }
  walk(payload)

  if (plainFallback !== null) return plainFallback
  if (htmlFallback !== null) return stripHtml(htmlFallback)
  return null
}

export interface GmailAttachmentPart {
  filename: string
  mimeType: string
  attachmentId: string
  size: number
}

/** Collects every part that's an actual attachment (has both a
 *  filename and an attachmentId — inline images/parts without a
 *  filename are body content, not attachments). */
export function findAttachmentParts(payload: GmailPayloadPart | undefined): GmailAttachmentPart[] {
  if (!payload) return []
  const found: GmailAttachmentPart[] = []
  function walk(part: GmailPayloadPart) {
    if (part.filename && part.body?.attachmentId) {
      found.push({
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        attachmentId: part.body.attachmentId,
        size: part.body.size ?? 0,
      })
    }
    for (const child of part.parts ?? []) walk(child)
  }
  walk(payload)
  return found
}

/** Parses `From: "Jane Doe" <jane@example.com>` into its parts. Falls
 *  back to treating the whole header as the address if there's no
 *  angle-bracket form (a bare address, which Gmail also sends). */
export function parseFromHeader(value: string | null): { name: string | null; address: string | null } {
  if (!value) return { name: null, address: null }
  const match = /^(.*?)<([^>]+)>\s*$/.exec(value.trim())
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, '')
    return { name: name || null, address: match[2].trim() }
  }
  return { name: null, address: value.trim() }
}
