// ============================================================
// Shared request plumbing for the widget routes that act on behalf of an
// already-bootstrapped visitor (/message, /upload-url, /receipt).
//
// Order matches what /message always did: bearer JWT -> widget_visitors
// row -> config (CORS allow-list, enabled) -> rate limit. Everything a
// route answers goes through `widgetJson` so the error shape is the one
// contract shape: `{ error: string, code?: string }`.
// ============================================================
import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, type RateLimitOptions } from '@/lib/rate-limit'
import { resolveCorsOrigin, withCors } from '@/lib/widget/cors'

export type WidgetErrorCode =
  | 'rate_limited'
  | 'invalid_claim'
  | 'file_too_large'
  | 'file_type_not_allowed'
  | 'not_found'
  | 'bad_request'

/** Error response in the contract shape, with CORS when the origin is known. */
export function widgetError(
  status: number,
  error: string,
  code?: WidgetErrorCode,
  corsOrigin?: string | null,
): NextResponse {
  const res = NextResponse.json(code ? { error, code } : { error }, { status })
  return corsOrigin ? withCors(res, corsOrigin) : res
}

/** A 429 in the contract shape (`code: 'rate_limited'`, `Retry-After`). */
export function widgetRateLimited(
  result: ReturnType<typeof checkRateLimit>,
  corsOrigin?: string | null,
): NextResponse {
  const base = rateLimitResponse(result)
  const body = { error: 'Rate limit exceeded', code: 'rate_limited', retry_after_seconds: 0 }
  const retry = Number(base.headers.get('Retry-After') ?? '1')
  body.retry_after_seconds = retry
  const res = NextResponse.json(body, { status: 429, headers: base.headers })
  return corsOrigin ? withCors(res, corsOrigin) : res
}

export function bearerToken(request: Request): string {
  const authHeader = request.headers.get('authorization') ?? ''
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
}

/** Verify the visitor's anonymous-auth JWT; returns the auth uid or null. */
export async function verifyVisitorJwt(token: string): Promise<string | null> {
  if (!token) return null
  const anonClient = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
  const { data, error } = await anonClient.auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

export interface WidgetVisitorContext {
  admin: SupabaseClient
  visitorId: string
  accountId: string
  contactId: string
  widgetConfigId: string
  corsOrigin: string
}

/**
 * Authenticate a request from a bootstrapped visitor. On failure returns
 * the response to send. `rate` (optional) is checked per visitor.
 */
export async function authenticateVisitorRequest(
  request: Request,
  opts: { logTag: string; rate?: { key: string; options: RateLimitOptions } },
): Promise<{ ok: true; ctx: WidgetVisitorContext } | { ok: false; response: NextResponse }> {
  const requestOrigin = request.headers.get('origin')
  const admin = supabaseAdmin()

  const token = bearerToken(request)
  if (!token) return { ok: false, response: widgetError(401, 'Missing Authorization bearer token') }

  const visitorId = await verifyVisitorJwt(token)
  if (!visitorId) return { ok: false, response: widgetError(401, 'Invalid or expired session') }

  const { data: visitor, error: visitorError } = await admin
    .from('widget_visitors')
    .select('account_id, contact_id, widget_config_id')
    .eq('id', visitorId)
    .maybeSingle()
  if (visitorError) {
    console.error(`[${opts.logTag}] visitor lookup error:`, visitorError)
    return { ok: false, response: widgetError(500, 'Internal server error') }
  }
  if (!visitor) {
    return { ok: false, response: widgetError(401, 'No active widget session for this visitor') }
  }

  const { data: config } = await admin
    .from('web_widget_config')
    .select('allowed_origins, enabled')
    .eq('id', visitor.widget_config_id)
    .maybeSingle()

  const corsOrigin = resolveCorsOrigin(requestOrigin, config?.allowed_origins ?? [])
  if (!corsOrigin) return { ok: false, response: widgetError(403, 'Origin not allowed for this widget') }
  if (!config?.enabled) return { ok: false, response: widgetError(403, 'Widget is disabled', undefined, corsOrigin) }

  if (opts.rate) {
    const limit = checkRateLimit(opts.rate.key.replace('{visitor}', visitorId), opts.rate.options)
    if (!limit.success) return { ok: false, response: widgetRateLimited(limit, corsOrigin) }
  }

  return {
    ok: true,
    ctx: {
      admin,
      visitorId,
      accountId: visitor.account_id as string,
      contactId: visitor.contact_id as string,
      widgetConfigId: visitor.widget_config_id as string,
      corsOrigin,
    },
  }
}

/** The conversation must belong to THIS visitor's own contact. */
export async function loadOwnedConversation(
  ctx: WidgetVisitorContext,
  conversationId: string,
): Promise<{ id: string; account_id: string; contact_id: string; status: string } | null> {
  const { data, error } = await ctx.admin
    .from('conversations')
    .select('id, account_id, contact_id, status')
    .eq('id', conversationId)
    .eq('account_id', ctx.accountId)
    .eq('contact_id', ctx.contactId)
    .maybeSingle()
  if (error) throw error
  return (data as { id: string; account_id: string; contact_id: string; status: string } | null) ?? null
}
