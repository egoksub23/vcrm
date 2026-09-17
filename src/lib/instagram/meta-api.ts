/**
 * Instagram Messaging API helpers — nearly identical to Messenger's
 * Send API, scoped to the linked IG professional account instead of a
 * Page. Named-params-object convention, matching
 * `src/lib/whatsapp/meta-api.ts`.
 */

import { throwMetaError } from '@/lib/meta/errors'

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export interface MetaSendResult {
  messageId: string
}

interface SendResponse {
  recipient_id: string
  message_id: string
}

export interface SendInstagramTextArgs {
  igBusinessAccountId: string
  pageAccessToken: string
  recipientIgsid: string
  text: string
}

export async function sendInstagramText(args: SendInstagramTextArgs): Promise<MetaSendResult> {
  const { igBusinessAccountId, pageAccessToken, recipientIgsid, text } = args
  const response = await fetch(`${META_API_BASE}/${igBusinessAccountId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pageAccessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientIgsid },
      message: { text },
    }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Instagram API error: ${response.status}`)
  }
  const data = (await response.json()) as SendResponse
  return { messageId: data.message_id }
}

export type InstagramMediaKind = 'image' | 'video' | 'audio' | 'file'

export interface SendInstagramMediaArgs {
  igBusinessAccountId: string
  pageAccessToken: string
  recipientIgsid: string
  kind: InstagramMediaKind
  url: string
}

export async function sendInstagramMedia(args: SendInstagramMediaArgs): Promise<MetaSendResult> {
  const { igBusinessAccountId, pageAccessToken, recipientIgsid, kind, url } = args
  const response = await fetch(`${META_API_BASE}/${igBusinessAccountId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pageAccessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientIgsid },
      message: { attachment: { type: kind, payload: { url, is_reusable: true } } },
    }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Instagram API error: ${response.status}`)
  }
  const data = (await response.json()) as SendResponse
  return { messageId: data.message_id }
}
