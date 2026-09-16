// ============================================================
// POST /api/widget/session
//
// First call the embedded widget bundle makes on load. It has
// already called `supabase.auth.signInAnonymously()` itself (using
// the public anon key) and sends that session's access token as a
// bearer credential — this route verifies it, then finds-or-creates
// the `widget_visitors` / `contacts` / `conversations` rows for that
// visitor and hands back the conversation to subscribe to.
//
// Public, unauthenticated (any origin can call it, subject to the
// account's own `allowed_origins` allow-list) and CORS-enabled —
// unlike every other route in the app, which is either a dashboard
// session (cookies) or a bearer API key (`/api/v1/*`).
// ============================================================
import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { corsPreflight, resolveCorsOrigin, withCors } from '@/lib/widget/cors'

const NAME_MAX_LEN = 120
const EMAIL_MAX_LEN = 200

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

export async function POST(request: Request) {
  const requestOrigin = request.headers.get('origin')

  const body = (await request.json().catch(() => null)) as
    | { widgetToken?: unknown; visitorName?: unknown; visitorEmail?: unknown }
    | null
  const widgetToken = typeof body?.widgetToken === 'string' ? body.widgetToken : ''
  if (!widgetToken) {
    return NextResponse.json({ error: 'widgetToken is required' }, { status: 400 })
  }

  const admin = supabaseAdmin()

  const { data: config, error: configError } = await admin
    .from('web_widget_config')
    .select('id, account_id, enabled, allowed_origins, name, welcome_message, primary_color, avatar_url, position')
    .eq('widget_token', widgetToken)
    .maybeSingle()

  if (configError) {
    console.error('[widget/session] config lookup error:', configError)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  if (!config || !config.enabled) {
    return NextResponse.json({ error: 'Widget not found or disabled' }, { status: 404 })
  }

  const corsOrigin = resolveCorsOrigin(requestOrigin, config.allowed_origins ?? [])
  if (!corsOrigin) {
    return NextResponse.json({ error: 'Origin not allowed for this widget' }, { status: 403 })
  }

  const limit = checkRateLimit(`widget:session:${widgetToken}:${requestOrigin ?? 'unknown'}`, RATE_LIMITS.widgetSession)
  if (!limit.success) return withCors(rateLimitResponse(limit), corsOrigin)

  // Verify the visitor's anonymous-auth JWT server-side. A plain anon
  // client (not the service role) doing `.auth.getUser(token)` calls
  // GoTrue's /user endpoint, which validates the token's signature and
  // expiry and returns the auth.users row it belongs to — exactly what
  // `supabase.auth.getUser()` does for a cookie session, just handed a
  // token explicitly instead of reading it from cookies.
  const authHeader = request.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) {
    return withCors(
      NextResponse.json({ error: 'Missing Authorization bearer token' }, { status: 401 }),
      corsOrigin,
    )
  }

  const anonClient = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
  const { data: userData, error: userError } = await anonClient.auth.getUser(token)
  if (userError || !userData.user) {
    return withCors(NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 }), corsOrigin)
  }
  const visitorId = userData.user.id

  const visitorName =
    typeof body?.visitorName === 'string' ? body.visitorName.trim().slice(0, NAME_MAX_LEN) : ''
  const visitorEmail =
    typeof body?.visitorEmail === 'string' ? body.visitorEmail.trim().slice(0, EMAIL_MAX_LEN) : ''

  try {
    let ownerUserId: string
    try {
      ownerUserId = await resolveAuditUserId(admin, config.account_id)
    } catch (err) {
      if (err instanceof ContactError) {
        return withCors(NextResponse.json({ error: err.message }, { status: err.status }), corsOrigin)
      }
      throw err
    }

    // ---- contact: find by widget_visitor_id, or create -----------
    let contactId: string
    const { data: existingContact } = await admin
      .from('contacts')
      .select('id, name, email')
      .eq('account_id', config.account_id)
      .eq('widget_visitor_id', visitorId)
      .maybeSingle()

    let contactCreated = false
    if (existingContact) {
      contactId = existingContact.id
      // A visitor who types their name/email after already chatting
      // once fills the gap rather than overwriting a name they set.
      const patch: Record<string, string> = {}
      if (visitorName && !existingContact.name) patch.name = visitorName
      if (visitorEmail && !existingContact.email) patch.email = visitorEmail
      if (Object.keys(patch).length > 0) {
        await admin.from('contacts').update(patch).eq('id', contactId)
      }
    } else {
      const { data: created, error: createErr } = await admin
        .from('contacts')
        .insert({
          account_id: config.account_id,
          user_id: ownerUserId,
          phone: '',
          widget_visitor_id: visitorId,
          name: visitorName || 'Website visitor',
          email: visitorEmail || null,
        })
        .select('id')
        .single()

      if (createErr || !created) {
        if (isUniqueViolation(createErr)) {
          const { data: raced } = await admin
            .from('contacts')
            .select('id')
            .eq('account_id', config.account_id)
            .eq('widget_visitor_id', visitorId)
            .maybeSingle()
          if (!raced) throw new Error('Failed to resolve contact after race')
          contactId = raced.id
        } else {
          console.error('[widget/session] contact create error:', createErr)
          return withCors(NextResponse.json({ error: 'Failed to start session' }, { status: 500 }), corsOrigin)
        }
      } else {
        contactId = created.id
        contactCreated = true
      }
    }

    // ---- conversation: find or create (account, contact, web_widget) --
    const { data: existingConv } = await admin
      .from('conversations')
      .select('id')
      .eq('account_id', config.account_id)
      .eq('contact_id', contactId)
      .eq('channel_type', 'web_widget')
      .order('created_at', { ascending: true })
      .limit(1)

    let conversationId: string
    if (existingConv && existingConv.length > 0) {
      conversationId = existingConv[0].id
    } else {
      const { data: newConv, error: convErr } = await admin
        .from('conversations')
        .insert({
          account_id: config.account_id,
          user_id: ownerUserId,
          contact_id: contactId,
          channel_type: 'web_widget',
        })
        .select('id')
        .single()

      if (convErr || !newConv) {
        if (isUniqueViolation(convErr)) {
          const { data: raced } = await admin
            .from('conversations')
            .select('id')
            .eq('account_id', config.account_id)
            .eq('contact_id', contactId)
            .eq('channel_type', 'web_widget')
            .order('created_at', { ascending: true })
            .limit(1)
          if (!raced || raced.length === 0) throw new Error('Failed to resolve conversation after race')
          conversationId = raced[0].id
        } else {
          console.error('[widget/session] conversation create error:', convErr)
          return withCors(NextResponse.json({ error: 'Failed to start session' }, { status: 500 }), corsOrigin)
        }
      } else {
        conversationId = newConv.id
      }
    }

    // ---- visitor mapping (upsert; keeps last_seen_at fresh) -------
    await admin.from('widget_visitors').upsert(
      {
        id: visitorId,
        account_id: config.account_id,
        contact_id: contactId,
        widget_config_id: config.id,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )

    if (contactCreated) {
      await runAutomationsForTrigger({
        accountId: config.account_id,
        triggerType: 'new_contact_created',
        contactId,
        context: { conversation_id: conversationId },
      }).catch((err) => console.error('[widget/session] new_contact_created dispatch failed:', err))
    }

    return withCors(
      NextResponse.json({
        conversationId,
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        branding: {
          name: config.name,
          welcomeMessage: config.welcome_message,
          primaryColor: config.primary_color,
          avatarUrl: config.avatar_url,
          position: config.position,
        },
      }),
      corsOrigin,
    )
  } catch (err) {
    console.error('[widget/session] unexpected error:', err)
    return withCors(NextResponse.json({ error: 'Internal server error' }, { status: 500 }), corsOrigin)
  }
}
