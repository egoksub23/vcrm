/**
 * Facebook Messenger Send API helpers.
 *
 * Named-params-object convention, matching `src/lib/whatsapp/meta-api.ts`
 * (chosen there after repeated positional-arg swap bugs).
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

export interface SendMessengerTextArgs {
  pageId: string
  pageAccessToken: string
  recipientPsid: string
  text: string
}

export async function sendMessengerText(args: SendMessengerTextArgs): Promise<MetaSendResult> {
  const { pageId, pageAccessToken, recipientPsid, text } = args
  const response = await fetch(`${META_API_BASE}/${pageId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pageAccessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientPsid },
      message: { text },
      messaging_type: 'RESPONSE',
    }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Messenger API error: ${response.status}`)
  }
  const data = (await response.json()) as SendResponse
  return { messageId: data.message_id }
}

export type MessengerMediaKind = 'image' | 'video' | 'audio' | 'file'

export interface SendMessengerMediaArgs {
  pageId: string
  pageAccessToken: string
  recipientPsid: string
  kind: MessengerMediaKind
  url: string
}

export async function sendMessengerMedia(args: SendMessengerMediaArgs): Promise<MetaSendResult> {
  const { pageId, pageAccessToken, recipientPsid, kind, url } = args
  const response = await fetch(`${META_API_BASE}/${pageId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pageAccessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientPsid },
      message: { attachment: { type: kind, payload: { url, is_reusable: true } } },
      messaging_type: 'RESPONSE',
    }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Messenger API error: ${response.status}`)
  }
  const data = (await response.json()) as SendResponse
  return { messageId: data.message_id }
}

/** Best-effort display-name lookup for a new PSID-only contact. May 400
 *  depending on the app's review status — callers must treat a failure
 *  as non-fatal and fall back to a generic label. */
export async function getMessengerUserProfile(args: {
  psid: string
  pageAccessToken: string
}): Promise<{ firstName?: string; lastName?: string } | null> {
  const params = new URLSearchParams({
    fields: 'first_name,last_name',
    access_token: args.pageAccessToken,
  })
  const response = await fetch(`${META_API_BASE}/${args.psid}?${params.toString()}`)
  if (!response.ok) return null
  const data = (await response.json().catch(() => null)) as {
    first_name?: string
    last_name?: string
  } | null
  if (!data) return null
  return { firstName: data.first_name, lastName: data.last_name }
}
