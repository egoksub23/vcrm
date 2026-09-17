// ============================================================
// POST /api/widget/session
//
// First call the embedded widget bundle makes on load. It has
// already called `supabase.auth.signInAnonymously()` itself (using
// the public anon key) and sends that session's access token as a
// bearer credential — this route verifies it, then resolves the
// `contacts` / `conversations` rows for that visitor and hands back
// the conversation to subscribe to.
//
// Two-step protocol for identity: a brand-new browser session (no
// `widget_visitors` row yet) has no way to know who it's talking to,
// so the FIRST call — made with no `visitorPhone` — gets back
// `{ needsPhone: true }` instead of an error. The widget shows a
// phone-entry gate, then calls this route again with `visitorPhone`
// filled in. Identity is phone-first, not anonymous-auth-first: the
// phone is looked up against existing contacts in the account
// (`findExistingContact`, the same trunk-prefix-tolerant match every
// other phone-identified path in the app uses) so a visitor who has
// already messaged this business on WhatsApp lands on that SAME
// contact record — one unified history, even though the WhatsApp and
// widget conversations stay two separate `conversations` rows
// (different `channel_type`). A returning visitor on the SAME browser
// skips the gate entirely: `widget_visitors` (keyed by their anonymous
// auth uid) already points at a resolved contact from last time.
//
// This is intentionally unverified — there's no OTP. A visitor who
// types someone else's real phone number lands their chat on that
// person's contact record. That's a real, accepted trade-off (the
// same one every "enter your number to chat" widget makes without a
// verification step) rather than an oversight: the widget itself
// never exposes anything beyond its own conversation thread even when
// merged onto an existing contact — RLS scopes by `contact_id` /
// `conversation_id`, not "everything this contact ever said" — so the
// only real exposure is on the business side (an agent could be
// talking to someone who isn't actually who the contact record says).
//
// Public, unauthenticated (any origin can call it, subject to the
// account's own `allowed_origins` allow-list) and CORS-enabled —
// unlike every other route in the app, which is either a dashboard
// session (cookies) or a bearer API key (`/api/v1/*`).
// ============================================================
import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { corsPreflight, resolveCorsOrigin, withCors } from '@/lib/widget/cors'

const NAME_MAX_LEN = 120

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

export async function POST(request: Request) {
  const requestOrigin = request.headers.get('origin')

  const body = (await request.json().catch(() => null)) as
    | { widgetToken?: unknown; visitorName?: unknown; visitorPhone?: unknown }
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
  const rawPhone = typeof body?.visitorPhone === 'string' ? body.visitorPhone.trim() : ''

  const brandingPayload = {
    name: config.name,
    welcomeMessage: config.welcome_message,
    primaryColor: config.primary_color,
    avatarUrl: config.avatar_url,
    position: config.position,
  }

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

    // ---- fast path: this browser already has a resolved contact --
    const { data: knownVisitor } = await admin
      .from('widget_visitors')
      .select('contact_id')
      .eq('id', visitorId)
      .maybeSingle()

    let contactId: string
    let contactCreated = false

    if (knownVisitor) {
      contactId = knownVisitor.contact_id
      await admin
        .from('widget_visitors')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', visitorId)
    } else {
      // Brand-new browser session — identity is unknown until the
      // visitor supplies a phone number. First call (no phone yet)
      // gets a structured "ask for it" response, not an error.
      if (!rawPhone) {
        return withCors(NextResponse.json({ needsPhone: true, branding: brandingPayload }), corsOrigin)
      }

      const sanitizedPhone = sanitizePhoneForMeta(rawPhone)
      if (!isValidE164(sanitizedPhone)) {
        return withCors(
          NextResponse.json({ error: 'Enter a valid phone number' }, { status: 400 }),
          corsOrigin,
        )
      }

      const existing = await findExistingContact(admin, config.account_id, sanitizedPhone)
      if (existing) {
        contactId = existing.id
        if (visitorName && !existing.name) {
          await admin.from('contacts').update({ name: visitorName }).eq('id', contactId)
        }
      } else {
        const { data: created, error: createErr } = await admin
          .from('contacts')
          .insert({
            account_id: config.account_id,
            user_id: ownerUserId,
            phone: sanitizedPhone,
            widget_visitor_id: visitorId,
            name: visitorName || 'Website visitor',
          })
          .select('id')
          .single()

        if (createErr || !created) {
          if (isUniqueViolation(createErr)) {
            const raced = await findExistingContact(admin, config.account_id, sanitizedPhone)
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
    }

    // ---- conversation: find or create (account, contact) --
    //
    // No channel_type filter (migration 048 merged per-channel
    // conversations into one per contact) — a contact who has already
    // messaged via WhatsApp gets their existing conversation here too,
    // same shape as the WhatsApp webhook's own find-or-create.
    const { data: existingConv } = await admin
      .from('conversations')
      .select('id')
      .eq('account_id', config.account_id)
      .eq('contact_id', contactId)
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

    // Binds this browser to the resolved contact (new-visitor path) or
    // just refreshes last_seen_at (fast-path — already bound). One
    // upsert covers both since the row shape is identical either way.
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
      NextResponse.json({ conversationId, needsPhone: false, branding: brandingPayload }),
      corsOrigin,
    )
  } catch (err) {
    console.error('[widget/session] unexpected error:', err)
    return withCors(NextResponse.json({ error: 'Internal server error' }, { status: 500 }), corsOrigin)
  }
}
