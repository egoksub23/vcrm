import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { normalizeBaseUrl } from './presets'

/**
 * Validation for an OpenAI-compatible provider's base URL. An admin
 * types this and our server then calls it with a stored key, so it gets
 * the same SSRF treatment as a webhook URL: https only, no credentials
 * in the URL, and the host must resolve to a public address.
 */

export type BaseUrlProblem =
  | 'base_url_required'
  | 'base_url_invalid'
  | 'base_url_not_https'
  | 'base_url_blocked'

export type BaseUrlCheck = { ok: true; url: string } | { ok: false; code: BaseUrlProblem }

/** The checks that need no network: presence, syntax, https, no credentials/query. */
export function checkBaseUrlShape(raw: string | null | undefined): BaseUrlCheck {
  const url = normalizeBaseUrl(raw ?? '')
  if (!url) return { ok: false, code: 'base_url_required' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, code: 'base_url_invalid' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, code: 'base_url_not_https' }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, code: 'base_url_invalid' }
  }
  return { ok: true, url }
}

/** Shape checks, then resolve the host and refuse private / internal addresses. */
export async function validateBaseUrl(raw: string | null | undefined): Promise<BaseUrlCheck> {
  const shape = checkBaseUrlShape(raw)
  if (!shape.ok) return shape
  if (!(await isDeliverableUrl(shape.url))) return { ok: false, code: 'base_url_blocked' }
  return shape
}
