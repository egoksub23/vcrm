// ============================================================
// The real push adapter (work package 8): the Vircle "send mobile alert" API.
//
//   POST <PUSH_API_URL>            (for example https://apis.vircle.com/airtable/send-mobile-alert)
//   headers  Content-Type: application/json, x-api-key: <key>, x-api-stage: uat | prod
//   body     { "mobile_number": "...", "subject": "...", "body": "...", "data": { ... } }
//
// It alerts the app of the person who owns that phone number; the API finds the client and the device and writes the alert to its own queue
// (Kafka), the stage header choosing the environment. The phone matches with or without a leading `+`. A phone number that belongs to no client
// answers HTTP 404 with the code ERA03.
//
// `data` (added by Vircle on 23 Oct 2026) carries the custom fields the app needs to route a tap: the chat-alert marker, the conversation id and
// the deep link (`chatAlertData`, adapter.ts). It is a JSON object of string values. `PUSH_API_SEND_DATA=false` leaves it out, for a stage whose
// API does not know the field yet. The API has no separate deep link or collapse key: the link travels inside `data`.
//
// The key is read from the environment, sent only in the header and never logged or put in an error.
// ============================================================

import { log } from '../log'
import type { PushAdapter, PushRequest, PushResult } from './adapter'

export interface VirclePushOptions {
  /** The full https address of the send-mobile-alert endpoint. */
  url: string
  apiKey: string
  /** Which environment the API's queue belongs to (`x-api-stage`). Chosen explicitly: a wrong default would alert the wrong place. */
  stage: 'uat' | 'prod'
  /** Send the alert's `data` (default true). Switch off only for an API that does not know the field. */
  sendData?: boolean
  timeoutMs?: number
  /** Replaceable in tests. */
  fetch?: typeof fetch
}

/** The code the API answers when no client has that phone number. */
const NO_CLIENT = /ERA03/

export class VirclePushAdapter implements PushAdapter {
  readonly name = 'vircle'
  private readonly doFetch: typeof fetch

  constructor(private readonly opts: VirclePushOptions) {
    if (!/^https:\/\//i.test(opts.url)) throw new Error('The push API address must start with https://')
    if (!opts.apiKey) throw new Error('The push API key is required')
    this.doFetch = opts.fetch ?? fetch
  }

  async send(request: PushRequest): Promise<PushResult> {
    // The API names the person by phone number only: without one there is nobody to alert.
    if (!request.phone) return { status: 'no_device' }

    const payload: Record<string, unknown> = { mobile_number: request.phone, subject: request.title, body: request.body }
    if (this.opts.sendData !== false) payload.data = request.data

    let res: Response
    try {
      res = await this.doFetch(this.opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey, 'x-api-stage': this.opts.stage },
        body: JSON.stringify(payload),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'error'
      log.child('push').warn('The push API could not be reached', { reason })
      return { status: 'failed', error: `push API not reachable (${reason})`, retryable: true }
    }

    const text = await res.text().catch(() => '')
    if (res.status >= 200 && res.status < 300) return { status: 'sent' }
    // No client has this phone number: nothing to retry. (Any other 404 is a wrong address, not an unknown person.)
    if (res.status === 404 && NO_CLIENT.test(text)) return { status: 'no_device' }

    const retryable = res.status === 429 || res.status >= 500
    const code = /"(?:code|error_code|errorCode)"\s*:\s*"([A-Za-z0-9_-]{1,20})"/.exec(text)?.[1]
    log.child('push').warn('The push API refused an alert', { status: res.status, ...(code ? { code } : {}) })
    return { status: 'failed', error: `push API answered ${res.status}${code ? ` ${code}` : ''}`, retryable }
  }
}
