/**
 * Shared Gmail / Google API error shape — Google's failure envelope is
 * `{ error: { code, message, errors: [...], status } }`, a different
 * shape from both Meta's (`src/lib/meta/errors.ts`) and Microsoft
 * Graph's (`src/lib/ms365/errors.ts`), so this is its own small class.
 *
 * `httpStatus === 401` (Google's `status: "UNAUTHENTICATED"`) means the
 * stored access/refresh token pair no longer works. Callers check for
 * this to flip `needs_reauth` on `gmail_config`.
 */

interface GoogleErrorResponse {
  error?: {
    code?: number
    message?: string
    status?: string
  }
}

export class GmailApiError extends Error {
  readonly httpStatus: number
  readonly status: string | null

  constructor(message: string, fields: { httpStatus: number; status?: string | null }) {
    super(message)
    this.name = 'GmailApiError'
    this.httpStatus = fields.httpStatus
    this.status = fields.status ?? null
  }

  get isAuthError(): boolean {
    // Two different shapes can mean "this credential is dead":
    // - A Gmail API call rejects with 401 / status UNAUTHENTICATED.
    // - The OAuth token endpoint rejects a refresh_token grant with
    //   400 `{error: "invalid_grant"}` (revoked/expired refresh
    //   token) — `readGmailError`/`requestToken` both stash that
    //   string in `status` even though it isn't a Gmail API `status`
    //   enum value, so checking for it here catches the real-world
    //   dead-refresh-token case that a plain `401` check would miss.
    return this.httpStatus === 401 || this.status === 'UNAUTHENTICATED' || this.status === 'invalid_grant'
  }
}

export async function readGmailError(response: Response, fallback: string): Promise<GmailApiError> {
  let message = fallback
  let status: string | null = null
  try {
    const data = (await response.json()) as GoogleErrorResponse
    if (data.error?.message) message = data.error.message
    status = data.error?.status ?? null
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  return new GmailApiError(message, { httpStatus: response.status, status })
}

export async function throwGmailError(response: Response, fallback: string): Promise<never> {
  throw await readGmailError(response, fallback)
}
