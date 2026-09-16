import { NextResponse } from 'next/server'

// ============================================================
// CORS for the two public widget routes (/api/widget/session,
// /api/widget/message). The first cross-origin-by-design surface in
// the app — every other route only ever expects same-origin (the
// dashboard) or a bearer-key server-to-server caller (`/api/v1/*`),
// neither of which needs a CORS grant.
//
// Origin is checked against the account's own `allowed_origins`
// allow-list (set in Settings → Channels → Web Widget), never
// reflected blindly — an empty allow-list means "unrestricted",
// matching the plain `<script>`-embed model most widget products use
// (the visible, copy-pasted `data-widget-token` is the actual secret
// boundary, not the origin).
// ============================================================

const CORS_METHODS = 'POST, OPTIONS'
const CORS_HEADERS = 'Content-Type, Authorization'

/**
 * What to put in `Access-Control-Allow-Origin` for this request, or
 * null if the request's Origin isn't allowed at all (caller should
 * 403 rather than send a response with no CORS headers, which the
 * browser would block anyway but a same-origin tool/curl would not).
 */
export function resolveCorsOrigin(
  requestOrigin: string | null,
  allowedOrigins: string[],
): string | null {
  if (allowedOrigins.length === 0) return requestOrigin ?? '*'
  if (!requestOrigin) return null
  return allowedOrigins.includes(requestOrigin) ? requestOrigin : null
}

function baseHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_HEADERS,
    // No cookies/credentials cross-origin — auth is the bearer JWT the
    // widget carries explicitly in the Authorization header.
    Vary: 'Origin',
  }
}

/** Attach CORS headers to an existing response. */
export function withCors(response: NextResponse, origin: string): NextResponse {
  const headers = baseHeaders(origin)
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value)
  }
  return response
}

/** Standard preflight response for a route's `OPTIONS` handler. */
export function corsPreflight(origin: string | null): NextResponse {
  if (!origin) return new NextResponse(null, { status: 204 })
  return new NextResponse(null, { status: 204, headers: baseHeaders(origin) })
}
