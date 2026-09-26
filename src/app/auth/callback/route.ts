// ============================================================
// /auth/callback
//
//   GET — the redirect target Supabase Auth sends the browser back to
//         after a "Continue with Google/Microsoft" round-trip
//         (src/components/auth/oauth-buttons.tsx). Exchanges the `code`
//         query param for a real session (writing the auth cookies via
//         the request-scoped Supabase server client, src/lib/supabase/
//         server.ts) and redirects to `next` — `/dashboard` by default,
//         or `/join/<token>` when the OAuth button was clicked from
//         /login or /signup with an invite token in play (mirrors the
//         password-login flow's own destination choice).
//
// `next` is restricted to a same-origin relative path (must start with
// exactly one `/`) so this can't be used as an open redirect.
// ============================================================
import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'

function safeNextPath(raw: string | null): string {
  if (raw && /^\/(?!\/)/.test(raw)) return raw
  return '/dashboard'
}

/**
 * Absolute origin to redirect back to — `request.url`'s own origin can
 * be the app's internal address behind a reverse proxy (the VPS/Docker
 * deploy), not the public one the browser is actually on. Same
 * `NEXT_PUBLIC_SITE_URL`-preferred resolution as `src/lib/gmail/oauth.ts`
 * and `src/lib/ms365/oauth.ts`'s own `getOAuthBaseUrl` — duplicated here
 * rather than imported so account login has zero dependency on a
 * specific business-channel integration module (same reasoning those
 * two give for not sharing it with each other).
 */
function getBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`

  const host = request.headers.get('host')?.trim()
  if (host) {
    const reqProto = new URL(request.url).protocol.replace(':', '')
    return `${reqProto}://${host}`
  }

  return new URL(request.url).origin
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const next = safeNextPath(searchParams.get('next'))
  const base = getBaseUrl(request)

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${base}${next}`)
    }
    console.error('[GET /auth/callback] exchangeCodeForSession error:', error.message)
  }

  return NextResponse.redirect(`${base}/login?error=oauth_failed`)
}
