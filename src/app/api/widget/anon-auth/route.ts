// ============================================================
// POST /api/widget/anon-auth
//
// Issues a fresh anonymous-visitor JWT, signed with JWT_SECRET
// so that verifyVisitorJwt() (jose jwtVerify, same key) accepts it on
// every subsequent widget API call. The widget stores the token in
// localStorage and reuses it across page loads — the UUID in the `sub`
// claim maps to widget_visitors.id, giving the visitor session continuity.
//
// CORS-open: the token is useless until paired with a valid widgetToken
// in /api/widget/session, which enforces its own origin allow-list.
// ============================================================
import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { SignJWT } from 'jose'

import { corsPreflight, withCors } from '@/lib/widget/cors'

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin')

  const rawSecret = process.env.JWT_SECRET
  if (!rawSecret) {
    return NextResponse.json({ error: 'Auth not configured' }, { status: 500 })
  }

  const secret = new TextEncoder().encode(rawSecret)
  const now = Math.floor(Date.now() / 1000)
  const exp = now + 7 * 24 * 60 * 60 // 7-day tokens: long enough to survive a week of daily use

  const token = await new SignJWT({ role: 'anon' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(randomUUID())
    .setAudience('authenticated')
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secret)

  return withCors(
    NextResponse.json({ token, expiresAt: new Date(exp * 1000).toISOString() }),
    // Echo the request origin; fall back to '*' for direct / non-browser calls.
    origin ?? '*',
  )
}
