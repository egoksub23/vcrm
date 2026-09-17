/**
 * Shared Graph API error shape — a copy (not a re-export) of
 * `src/lib/whatsapp/meta-api.ts`'s `MetaApiError`/`readMetaError`/
 * `throwMetaError`, so the well-tested WhatsApp module is never at risk
 * from a change made for Messenger/Instagram/OAuth. All Meta Graph API
 * products return the same `{error: {message, code, error_subcode, type,
 * fbtrace_id}}` envelope, so one copy here is shared by
 * `src/lib/messenger/meta-api.ts`, `src/lib/instagram/meta-api.ts`, and
 * `src/lib/meta/oauth.ts`.
 */

interface MetaErrorResponse {
  error?: {
    message?: string
    code?: number
    error_subcode?: number
    type?: string
    fbtrace_id?: string
    error_data?: { messaging_product?: string; details?: string }
  }
}

/**
 * A Graph API failure with Meta's structured envelope preserved.
 *
 * `code === 190` is Meta's OAuthException — an invalid or expired
 * token. Callers in the Messenger/Instagram send path check for this
 * specifically to flip `needs_reauth` on the connection's config row.
 */
export class MetaApiError extends Error {
  readonly code: number | null
  readonly subcode: number | null
  readonly type: string | null
  readonly fbtraceId: string | null
  readonly httpStatus: number
  readonly details: string | null

  constructor(
    message: string,
    fields: {
      code?: number | null
      subcode?: number | null
      type?: string | null
      fbtraceId?: string | null
      httpStatus: number
      details?: string | null
    },
  ) {
    super(message)
    this.name = 'MetaApiError'
    this.code = fields.code ?? null
    this.subcode = fields.subcode ?? null
    this.type = fields.type ?? null
    this.fbtraceId = fields.fbtraceId ?? null
    this.httpStatus = fields.httpStatus
    this.details = fields.details ?? null
  }
}

/**
 * Read a failed Graph response into a MetaApiError without throwing.
 * Consumes the body — call at most once per response.
 */
export async function readMetaError(response: Response, fallback: string): Promise<MetaApiError> {
  let message = fallback
  let envelope: MetaErrorResponse['error'] | undefined
  try {
    const data = (await response.json()) as MetaErrorResponse
    envelope = data.error
    if (envelope?.message) message = envelope.message
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  return new MetaApiError(message, {
    code: typeof envelope?.code === 'number' ? envelope.code : null,
    subcode: typeof envelope?.error_subcode === 'number' ? envelope.error_subcode : null,
    type: envelope?.type ?? null,
    fbtraceId: envelope?.fbtrace_id ?? null,
    httpStatus: response.status,
    details: envelope?.error_data?.details ?? null,
  })
}

export async function throwMetaError(response: Response, fallback: string): Promise<never> {
  throw await readMetaError(response, fallback)
}
