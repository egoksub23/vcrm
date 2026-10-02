// ============================================================
// /auth/confirm
//
//   GET ?token_hash=...&type=recovery|invite|magiclink|email&next=/path
//
// Server-side OTP confirmation for links that carry a Supabase
// `token_hash` rather than a PKCE `code` — the platform operator's
// "set your password" email for a newly created customer workspace
// (src/app/api/platform/accounts/route.ts builds the link from
// `auth.admin.generateLink`). Verifying here writes the session cookies
// on the server, so it works in any browser and does not depend on
// Supabase redirecting back with a URL fragment.
//
// `next` is restricted to a same-origin relative path so this cannot be
// used as an open redirect.
// ============================================================
import { NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'

import { createClient } from '@/lib/supabase/server'

const OTP_TYPES: readonly EmailOtpType[] = ['recovery', 'invite', 'magiclink', 'email', 'signup']

function safeNextPath(raw: string | null): string {
  if (raw && /^\/(?!\/)/.test(raw)) return raw
  return '/dashboard'
}

/** Same public-origin resolution as /auth/callback (behind a reverse proxy
 *  `request.url`'s own origin can be the internal address). */
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
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = safeNextPath(searchParams.get('next'))
  const base = getBaseUrl(request)

  if (tokenHash && type && OTP_TYPES.includes(type)) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (!error) {
      return NextResponse.redirect(`${base}${next}`)
    }
    console.error('[GET /auth/confirm] verifyOtp error:', error.message)
  }

  return NextResponse.redirect(`${base}/login?error=link_expired`)
}
