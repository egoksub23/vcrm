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
// Three ways a visitor's identity can arrive (migration 054):
//
//   1. `verifiedIdentity: { phone, walletId?, email? }` — the embed is
//      running inside Vircle's own app/WebView, which already has a
//      signed-in, verified user and hands their identity straight to
//      the widget at init (loader `data-user-*` attributes, or an
//      async `window.VircleWidget.identify()` call). This is TRUSTED —
//      no gate is ever shown, the visitor never has to type anything.
//      A malformed phone here is a host-integration bug, not a user
//      mistake, so it's logged and the visitor silently falls through
//      to the normal self-service flow rather than erroring in front
//      of a real customer.
//   2. `visitorPhone` — self-service: the visitor typed their own
//      phone into the widget's gate, in response to `needsPhone: true`
//      from a prior call with neither `verifiedIdentity` nor
//      `skipIdentity` set. Unverified — same accepted trade-off as
//      before (see below).
//   3. `skipIdentity: true` — the visitor answered "no" (or skipped)
//      the "are you already a Vircle user?" prompt. Starts a plain
//      anonymous guest contact (`phone: ''`, keyed only by
//      `widget_visitor_id`), same as the original migration-046
//      behaviour before the phone gate existed.
//
// Phone-first identity, not anonymous-auth-first: a resolved phone
// (case 1 or 2) is looked up against existing contacts in the account
// (`findExistingContact`, the same trunk-prefix-tolerant match every
// other phone-identified path in the app uses) so a visitor who has
// already messaged this business on WhatsApp lands on that SAME
// contact record — one unified history, even though the WhatsApp and
// widget conversations stay two separate `conversations` rows... no,
// actually one merged conversation (migration 048). A returning
// visitor on the SAME browser skips all of this: `widget_visitors`
// (keyed by their anonymous auth uid) already points at a resolved
// contact from last time.
//
// Self-service linking, mid-session: a browser already bound to a
// GUEST contact (empty phone) that now supplies a phone (either case
// 1 or 2, arriving late — the visitor clicked "link your account" after
// chatting a while, or a host app's async identify() call landed after
// the widget already mounted) gets its guest history folded into the
// phone-matched contact via `merge_widget_guest_contact` (migration
// 054) — the widget then has to swap its active conversation and
// refetch history, since the id it already has can change.
//
// This is intentionally unverified for cases 2/3 — there's no OTP. A
// self-service visitor who types someone else's real phone number
// lands their chat on that person's contact record. That's a real,
// accepted trade-off (the same one every "enter your number to chat"
// widget makes without a verification step) rather than an oversight:
// the widget itself never exposes anything beyond its own conversation
// thread even when merged onto an existing contact — RLS scopes by
// `contact_id` / `conversation_id`, not "everything this contact ever
// said" — so the only real exposure is on the business side (an agent
// could be talking to someone who isn't actually who the contact
// record says). Case 1 (verifiedIdentity) doesn't carry this risk to
// begin with — the host app already verified the phone belongs to its
// signed-in user before ever calling the widget.
//
// Public, unauthenticated (any origin can call it, subject to the
// account's own `allowed_origins` allow-list) and CORS-enabled —
// unlike every other route in the app, which is either a dashboard
// session (cookies) or a bearer API key (`/api/v1/*`).
// ============================================================
import { NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { corsPreflight, resolveCorsOrigin, withCors } from '@/lib/widget/cors'
import { resolveOrCreateContactByPhone, findOrCreatePrimaryConversation } from '@/lib/widget/session-identity'

const NAME_MAX_LEN = 120
const WALLET_ID_MAX_LEN = 128
const EMAIL_MAX_LEN = 254

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

export async function POST(request: Request) {
  const requestOrigin = request.headers.get('origin')

  const body = (await request.json().catch(() => null)) as
    | {
        widgetToken?: unknown
        visitorName?: unknown
        visitorPhone?: unknown
        skipIdentity?: unknown
        verifiedIdentity?: { phone?: unknown; walletId?: unknown; email?: unknown }
      }
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
  const rawSelfPhone = typeof body?.visitorPhone === 'string' ? body.visitorPhone.trim() : ''
  const skipIdentity = body?.skipIdentity === true

  // verifiedIdentity — trusted, host-app-supplied. A bad phone shape
  // here is logged and dropped rather than erroring (see file header).
  const rawVerifiedPhone =
    typeof body?.verifiedIdentity?.phone === 'string' ? body.verifiedIdentity.phone.trim() : ''
  let verifiedPhone: string | null = null
  if (rawVerifiedPhone) {
    const sanitized = sanitizePhoneForMeta(rawVerifiedPhone)
    if (isValidE164(sanitized)) {
      verifiedPhone = sanitized
    } else {
      console.warn('[widget/session] verifiedIdentity.phone is not a valid phone number, ignoring', {
        widgetToken,
      })
    }
  }
  const walletId =
    typeof body?.verifiedIdentity?.walletId === 'string'
      ? body.verifiedIdentity.walletId.trim().slice(0, WALLET_ID_MAX_LEN)
      : ''
  const verifiedEmail =
    typeof body?.verifiedIdentity?.email === 'string'
      ? body.verifiedIdentity.email.trim().slice(0, EMAIL_MAX_LEN)
      : ''

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

    // ---- validate a self-service typed phone up front (unchanged
    // error contract: a bad typed phone is a 400, not a silent fall-
    // through — only the TRUSTED verifiedIdentity path gets that). --
    let selfPhone: string | null = null
    if (!verifiedPhone && rawSelfPhone) {
      const sanitized = sanitizePhoneForMeta(rawSelfPhone)
      if (!isValidE164(sanitized)) {
        return withCors(
          NextResponse.json({ error: 'Enter a valid phone number' }, { status: 400 }),
          corsOrigin,
        )
      }
      selfPhone = sanitized
    }
    const incomingPhone = verifiedPhone ?? selfPhone

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

      // Self-service linking / a late verifiedIdentity handoff — only
      // meaningful if this visitor is CURRENTLY a guest (empty phone).
      // An already-identified visitor's identity never changes here.
      if (incomingPhone) {
        const { data: currentContact } = await admin
          .from('contacts')
          .select('phone')
          .eq('id', contactId)
          .maybeSingle()

        if (currentContact && !currentContact.phone) {
          const { contactId: targetContactId } = await resolveOrCreateContactByPhone(
            admin,
            config.account_id,
            ownerUserId,
            incomingPhone,
            { name: visitorName, walletId, email: verifiedEmail },
          )

          if (targetContactId !== contactId) {
            const { error: mergeErr } = await admin.rpc('merge_widget_guest_contact', {
              p_account_id: config.account_id,
              p_guest_contact_id: contactId,
              p_target_contact_id: targetContactId,
            })
            if (mergeErr) {
              // Don't fail the whole session over a merge hiccup — the
              // visitor keeps chatting as a guest and can try linking
              // again later.
              console.error('[widget/session] guest merge failed:', mergeErr)
            } else {
              // Falls through to the common find-or-create /
              // widget_visitors upsert / response below, same as every
              // other path — `findOrCreatePrimaryConversation` just
              // finds the conversation the merge RPC already produced.
              contactId = targetContactId
              await admin
                .from('widget_visitors')
                .update({ contact_id: contactId })
                .eq('id', visitorId)
            }
          }
        }
      }
    } else if (incomingPhone) {
      const result = await resolveOrCreateContactByPhone(
        admin,
        config.account_id,
        ownerUserId,
        incomingPhone,
        { name: visitorName, walletId, email: verifiedEmail },
      )
      contactId = result.contactId
      contactCreated = result.created
    } else if (skipIdentity) {
      const { data: created, error: createErr } = await admin
        .from('contacts')
        .insert({
          account_id: config.account_id,
          user_id: ownerUserId,
          phone: '',
          widget_visitor_id: visitorId,
          name: visitorName || 'Website visitor',
        })
        .select('id')
        .single()
      if (createErr || !created) {
        console.error('[widget/session] guest contact create error:', createErr)
        return withCors(NextResponse.json({ error: 'Failed to start session' }, { status: 500 }), corsOrigin)
      }
      contactId = created.id
      contactCreated = true
    } else {
      // Brand-new browser, no identity offered yet — the widget shows
      // "are you already a Vircle user?" (yes -> phone gate, no ->
      // calls back with skipIdentity) instead of a blocking phone form.
      return withCors(NextResponse.json({ needsPhone: true, branding: brandingPayload }), corsOrigin)
    }

    const conversationId = await findOrCreatePrimaryConversation(admin, config.account_id, ownerUserId, contactId)

    // Computed fresh from the resolved contact's actual phone rather
    // than tracked ad hoc through the branches above — a RETURNING
    // guest visitor (fast path, no identity offered this call) must
    // still report isGuest: true so the widget keeps showing its
    // "link your account" affordance.
    const { data: finalContact } = await admin.from('contacts').select('phone').eq('id', contactId).maybeSingle()
    const isGuest = !finalContact?.phone

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
      NextResponse.json({ conversationId, needsPhone: false, isGuest, branding: brandingPayload }),
      corsOrigin,
    )
  } catch (err) {
    console.error('[widget/session] unexpected error:', err)
    return withCors(NextResponse.json({ error: 'Internal server error' }, { status: 500 }), corsOrigin)
  }
}
