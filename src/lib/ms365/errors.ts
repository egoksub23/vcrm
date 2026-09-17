/**
 * Shared Microsoft Graph error shape — Graph's failure envelope is
 * `{ error: { code, message, innerError: { ... } } }`, a different
 * shape from Meta's `{ error: { message, code, ... } }` (see
 * `src/lib/meta/errors.ts`), so this is its own small class rather
 * than a forced reuse of the Meta one.
 *
 * `code === 'InvalidAuthenticationToken'` (or the token-endpoint's
 * `error === 'invalid_grant'` — see `src/lib/ms365/token.ts`) means the
 * stored access/refresh token pair no longer works. Callers check for
 * this to flip `needs_reauth` on `email_config`.
 */

interface GraphErrorResponse {
  error?: {
    code?: string
    message?: string
    innerError?: { 'request-id'?: string; date?: string }
  }
}

export class GraphApiError extends Error {
  readonly code: string | null
  readonly httpStatus: number
  readonly requestId: string | null

  constructor(
    message: string,
    fields: { code?: string | null; httpStatus: number; requestId?: string | null },
  ) {
    super(message)
    this.name = 'GraphApiError'
    this.code = fields.code ?? null
    this.httpStatus = fields.httpStatus
    this.requestId = fields.requestId ?? null
  }

  /** Graph's shape for "this token is dead, get a new one". */
  get isAuthError(): boolean {
    return this.httpStatus === 401 || this.code === 'InvalidAuthenticationToken'
  }
}

export async function readGraphError(response: Response, fallback: string): Promise<GraphApiError> {
  let message = fallback
  let envelope: GraphErrorResponse['error'] | undefined
  try {
    const data = (await response.json()) as GraphErrorResponse
    envelope = data.error
    if (envelope?.message) message = envelope.message
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  return new GraphApiError(message, {
    code: envelope?.code ?? null,
    httpStatus: response.status,
    requestId: envelope?.innerError?.['request-id'] ?? null,
  })
}

export async function throwGraphError(response: Response, fallback: string): Promise<never> {
  throw await readGraphError(response, fallback)
}
