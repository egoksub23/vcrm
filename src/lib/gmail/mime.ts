/**
 * RFC 822 message building (for sends) and Gmail API payload walking
 * (for reads). Gmail's send API takes a raw base64url-encoded email
 * rather than Graph's structured JSON body, and its read API returns a
 * MIME multipart tree rather than a single pre-rendered plain-text
 * field the way Graph's `Prefer: outlook.body-content-type="text"`
 * header gives — both are genuinely new shapes in this codebase, kept
 * in one small file rather than scattered across gmail-api.ts.
 */

import { stripHtml } from '@/lib/email/strip-html'

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
  /** Rich-text body (the WYSIWYG composer's output, quoted history
   *  already appended) — sent as the `text/html` alternative alongside
   *  `text`, which stays the plain-text fallback every mail client
   *  falls back to. Omit for a plain-text-only send. */
  html?: string
  /** RFC822 `Message-ID` header of the message being replied to, e.g.
   *  `<abc123@mail.gmail.com>` — set together for a threaded reply. */
  inReplyTo?: string
  references?: string
  attachment?: { name: string; contentType: string; contentBytesBase64: string }
}

/** Builds the base64url-encoded raw message `users.messages.send` expects. */
export function buildRawMessage(args: OutgoingMailArgs): string {
  const mixedBoundary = `part_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const altBoundary = `alt_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const headers: string[] = [
    `To: ${args.toAddress}`,
    `Subject: ${encodeMimeHeader(args.subject)}`,
    'MIME-Version: 1.0',
  ]
  if (args.inReplyTo) headers.push(`In-Reply-To: ${args.inReplyTo}`)
  if (args.references) headers.push(`References: ${args.references}`)

  // The plain-text/HTML pair, as either the whole body (own top-level
  // Content-Type header) or one part nested inside the multipart/mixed
  // envelope below (own Content-Type line, no top-level header needed).
  const textOnlyPart = ['Content-Type: text/plain; charset="UTF-8"', '', args.text].join('\r\n')
  const alternativeBody = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    args.text,
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    args.html,
    `--${altBoundary}--`,
  ].join('\r\n')
  const alternativePart = [`Content-Type: multipart/alternative; boundary="${altBoundary}"`, '', alternativeBody].join(
    '\r\n',
  )

  let body: string
  if (args.attachment) {
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`)
    body = [
      `--${mixedBoundary}`,
      args.html ? alternativePart : textOnlyPart,
      `--${mixedBoundary}`,
      `Content-Type: ${args.attachment.contentType}; name="${args.attachment.name}"`,
      `Content-Disposition: attachment; filename="${args.attachment.name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      args.attachment.contentBytesBase64,
      `--${mixedBoundary}--`,
    ].join('\r\n')
  } else if (args.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`)
    body = alternativeBody
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

/** Walks the payload tree depth-first, returning the first `text/plain`
 *  and `text/html` part bodies found (each independently, not one as a
 *  fallback for the other — callers that want both raw HTML *and* a
 *  plain-text derivation need both). */
function findBodyParts(payload: GmailPayloadPart | undefined): {
  plain: string | null
  html: string | null
} {
  let plain: string | null = null
  let html: string | null = null
  if (!payload) return { plain, html }

  function walk(part: GmailPayloadPart) {
    if (part.mimeType === 'text/plain' && part.body?.data && plain === null) {
      plain = decodeBase64Url(part.body.data).toString('utf-8')
    } else if (part.mimeType === 'text/html' && part.body?.data && html === null) {
      html = decodeBase64Url(part.body.data).toString('utf-8')
    }
    for (const child of part.parts ?? []) walk(child)
  }
  walk(payload)
  return { plain, html }
}

/**
 * Best available body text — prefers a `text/plain` part, falls back
 * to `text/html` (stripped). Returns null if neither is present (e.g.
 * an attachment-only message).
 */
export function findTextBody(payload: GmailPayloadPart | undefined): string | null {
  const { plain, html } = findBodyParts(payload)
  if (plain !== null) return plain
  if (html !== null) return stripHtml(html)
  return null
}

/** Raw `text/html` part body, unstripped, for a rendered view — null
 *  if the message has no HTML part at all (plain-text-only email). */
export function findHtmlBody(payload: GmailPayloadPart | undefined): string | null {
  return findBodyParts(payload).html
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
