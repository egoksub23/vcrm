// ============================================================
// POST /api/widget/session
//
// First call the embedded widget bundle makes on load. It has already
// called `supabase.auth.signInAnonymously()` itself and sends that
// session's access token as a bearer credential; this route verifies it,
// resolves the `contacts` / `conversations` rows for the visitor, and
// hands back the conversation to subscribe to.
//
// Identity (Web Widget v2, migration 092). Three levels, stored per
// browser on `widget_visitors.identity_level`:
//
//   guest     nothing offered; an anonymous contact keyed by the browser.
//   claimed   the visitor TYPED a phone/email ("I'm an existing user").
//             Unverified. Matches CRM contacts, but never auto-merges two
//             real contacts: a phone->A / email->B split records a
//             "Possible duplicate" suggestion for agents instead.
//   verified  the host app's own backend SIGNED an identity token with the
//             workspace secret. The only level that merges automatically.
//
// A returning browser resumes its stored level; a later token/claim can
// upgrade guest -> claimed -> verified. A GUEST contact is always folded
// into the contact the visitor identifies as (merge_widget_guest_contact),
// verified or not. Web verification (email/WhatsApp code) is a switch that
// is stored but not implemented yet: `verification.mode` is reported as-is.
//
// LEGACY request fields (`visitorPhone`, `verifiedIdentity`) from old
// cached loaders are still understood, as unverified claims. See
// src/lib/widget/session-request.ts.
//
// Public, CORS-enabled; the account's `allowed_origins` is the origin
// allow-list. Never reveals WHICH identifier matched or whether a contact
// exists, except through the boolean `claimFound`.
// ============================================================
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { corsPreflight, resolveCorsOrigin, withCors } from '@/lib/widget/cors'
import { findOrCreatePrimaryConversation } from '@/lib/widget/session-identity'
import {
  createSupabaseIdentityStore,
  maxLevel,
  resolveIdentityContact,
  type IdentityLevel,
  type IdentitySource,
} from '@/lib/widget/identity-resolve'
import { verifyIdentityToken, type IdentityPayload } from '@/lib/widget/identity-token'
import { decryptIdentitySecret } from '@/lib/widget/identity-secret'
import { claimMatchesContact, meaningfulName, parseSessionBody } from '@/lib/widget/session-request'
import { needsIdentityBody, needsVerificationBody, sessionBody } from '@/lib/widget/session-response'
import { startEmailCodeVerification } from '@/lib/widget/email-verification'
import { applyContactTagByName, WIDGET_TAG_CLAIMS_EXISTING } from '@/lib/widget/tags'
import {
  bearerToken,
  verifyVisitorJwt,
  widgetError,
  widgetRateLimited,
} from '@/lib/widget/visitor-auth'

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for') ?? ''
  return fwd.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown'
}

export async function POST(request: Request) {
  const requestOrigin = request.headers.get('origin')

  const parsed = parseSessionBody(await request.json().catch(() => null))
  if (!parsed.ok) return widgetError(parsed.status, parsed.error, parsed.code)
  const { widgetToken, visitorName, identityToken, claim, skipIdentity } = parsed.value

  const admin = supabaseAdmin()

  const { data: config, error: configError } = await admin
    .from('web_widget_config')
    .select(
      'id, account_id, enabled, allowed_origins, name, welcome_message, primary_color, avatar_url, position, verification_mode, identity_secret_enc',
    )
    .eq('widget_token', widgetToken)
    .maybeSingle()

  if (configError) {
    console.error('[widget/session] config lookup error:', configError)
    return widgetError(500, 'Internal server error')
  }
  if (!config || !config.enabled) return widgetError(404, 'Widget not found or disabled', 'not_found')

  const corsOrigin = resolveCorsOrigin(requestOrigin, config.allowed_origins ?? [])
  if (!corsOrigin) return widgetError(403, 'Origin not allowed for this widget')

  const limit = checkRateLimit(`widget:session:${widgetToken}:${requestOrigin ?? 'unknown'}`, RATE_LIMITS.widgetSession)
  if (!limit.success) return widgetRateLimited(limit, corsOrigin)

  const jwt = bearerToken(request)
  if (!jwt) return widgetError(401, 'Missing Authorization bearer token', undefined, corsOrigin)
  const visitorId = await verifyVisitorJwt(jwt)
  if (!visitorId) return widgetError(401, 'Invalid or expired session', undefined, corsOrigin)

  // ---- signed token ----------------------------------------------
  let tokenPayload: IdentityPayload | null = null
  let identityError: 'bad_identity_token' | 'expired_identity_token' | undefined
  if (identityToken) {
    const secret = decryptIdentitySecret(config.identity_secret_enc as string | null)
    const result = secret
      ? verifyIdentityToken(identityToken, secret)
      : ({ ok: false, error: 'bad_identity_token' } as const)
    if (result.ok) tokenPayload = result.payload
    else identityError = result.error
  }

  try {
    let ownerUserId: string
    try {
      ownerUserId = await resolveAuditUserId(admin, config.account_id)
    } catch (err) {
      if (err instanceof ContactError) return widgetError(err.status, err.message, undefined, corsOrigin)
      throw err
    }

    const { data: knownVisitor } = await admin
      .from('widget_visitors')
      .select('contact_id, identity_level, identity_source, identity_verified_at')
      .eq('id', visitorId)
      .maybeSingle()

    type ContactRow = { id: string; name: string | null; phone: string | null; email: string | null }
    let currentContact: ContactRow | null = null
    if (knownVisitor) {
      const { data } = await admin
        .from('contacts')
        .select('id, name, phone, email')
        .eq('id', knownVisitor.contact_id)
        .maybeSingle()
      currentContact = data as ContactRow | null
    }
    const knownLevel = ((knownVisitor?.identity_level as IdentityLevel | undefined) ?? 'guest') as IdentityLevel

    // ---- what is being offered this call? -------------------------
    // A valid token always wins. A typed claim is ignored for a browser
    // that is already verified (its identity is fixed), and skipped when
    // it merely repeats the contact the visitor is already on.
    type Offer = { mode: 'verified' | 'claimed'; phone: string | null; email: string | null; walletId: string | null; name: string | null }
    let offer: Offer | null = null
    if (tokenPayload) {
      const same =
        knownLevel === 'verified' &&
        currentContact &&
        claimMatchesContact(currentContact, { phone: tokenPayload.phone ?? null, email: tokenPayload.email ?? null })
      if (!same) {
        offer = {
          mode: 'verified',
          phone: tokenPayload.phone ?? null,
          email: tokenPayload.email ?? null,
          walletId: tokenPayload.walletId ?? null,
          name: tokenPayload.name ?? null,
        }
      }
    } else if (claim && knownLevel !== 'verified') {
      const same = knownVisitor && knownLevel !== 'guest' && currentContact && claimMatchesContact(currentContact, claim)
      if (!same) offer = { mode: 'claimed', phone: claim.phone, email: claim.email, walletId: null, name: claim.name }
    }

    // Typed claims are the enumeration surface: rate-limit them.
    if (offer?.mode === 'claimed') {
      const checks = [
        checkRateLimit(`widget:identity:${visitorId}`, RATE_LIMITS.widgetIdentity),
        checkRateLimit(`widget:identity:o:${widgetToken}:${requestOrigin ?? 'unknown'}`, RATE_LIMITS.widgetIdentityOrigin),
        checkRateLimit(`widget:identity:ip:${clientIp(request)}`, RATE_LIMITS.widgetIdentityIp),
      ]
      const blocked = checks.find((c) => !c.success)
      if (blocked) return widgetRateLimited(blocked, corsOrigin)
    }

    // Migration 110: a typed claim on an account with email-code
    // verification switched on never resolves to a contact directly —
    // it either sends a code (real match, email on file) or leaves no
    // trace at all (no match, or nothing to verify through). A signed
    // token (offer.mode === 'verified') is already the strong signal
    // this mode exists to approximate, so it skips this entirely.
    if (offer?.mode === 'claimed' && config.verification_mode === 'email_code') {
      const result = await startEmailCodeVerification(admin, {
        accountId: config.account_id,
        widgetConfigId: config.id,
        widgetName: config.name,
        visitorId,
        phone: offer.phone,
        email: offer.email,
      })
      if (!result.ok) {
        return withCors(NextResponse.json(needsIdentityBody(config, identityError)), corsOrigin)
      }
      return withCors(NextResponse.json(needsVerificationBody(config, result.maskedEmail)), corsOrigin)
    }

    const store = createSupabaseIdentityStore(admin)
    let contactId: string | null = currentContact?.id ?? null
    let contactCreated = false
    let level: IdentityLevel = knownLevel
    let source: IdentitySource | null = (knownVisitor?.identity_source as IdentitySource | null) ?? null
    let verifiedAt: string | null = (knownVisitor?.identity_verified_at as string | null) ?? null
    let claimFound: boolean | undefined

    if (offer) {
      const result = await resolveIdentityContact(store, {
        accountId: config.account_id,
        ownerUserId,
        identity: { phone: offer.phone, email: offer.email, walletId: offer.walletId, name: offer.name },
        verified: offer.mode === 'verified',
      })

      if (offer.mode === 'claimed') {
        claimFound = result.matched
        if (result.created) {
          await applyContactTagByName(admin, {
            accountId: config.account_id,
            ownerUserId,
            contactId: result.contactId,
            name: WIDGET_TAG_CLAIMS_EXISTING,
          })
        }
      }

      // Fold the visitor's own GUEST contact into the contact they
      // identified as (automatic, verified or not). A claimed/verified
      // browser switching identity just rebinds; it never auto-merges the
      // contact it was on.
      if (contactId && contactId !== result.contactId && knownLevel === 'guest') {
        const { error: mergeErr } = await admin.rpc('merge_widget_guest_contact', {
          p_account_id: config.account_id,
          p_guest_contact_id: contactId,
          p_target_contact_id: result.contactId,
        })
        if (mergeErr) console.error('[widget/session] guest merge failed:', mergeErr)
      }

      contactId = result.contactId
      contactCreated = result.created
      if (offer.mode === 'verified') {
        level = 'verified'
        source = 'signed_app'
        verifiedAt = new Date().toISOString()
      } else {
        level = maxLevel(knownLevel, 'claimed')
        source = source ?? 'typed'
      }
    } else if (!knownVisitor) {
      if (skipIdentity) {
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
          return widgetError(500, 'Failed to start session', undefined, corsOrigin)
        }
        contactId = created.id as string
        contactCreated = true
        level = 'guest'
      } else {
        // Brand-new browser, nothing offered: the widget shows the
        // existing-user vs enquiry choice.
        return withCors(NextResponse.json(needsIdentityBody(config, identityError)), corsOrigin)
      }
    }

    if (!contactId) return widgetError(500, 'Failed to resolve contact', undefined, corsOrigin)

    const conversationId = await findOrCreatePrimaryConversation(admin, config.account_id, ownerUserId, contactId)

    const { data: finalContact } = await admin
      .from('contacts')
      .select('name, phone, email')
      .eq('id', contactId)
      .maybeSingle()

    await admin.from('widget_visitors').upsert(
      {
        id: visitorId,
        account_id: config.account_id,
        contact_id: contactId,
        widget_config_id: config.id,
        last_seen_at: new Date().toISOString(),
        identity_level: level,
        identity_source: source,
        identity_verified_at: verifiedAt,
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

    // A name is only echoed back for a VERIFIED identity, or when the visitor
    // typed it themselves in this very request. An unverified claim must not
    // be able to read a real contact's name out of the CRM.
    const displayName =
      level === 'verified'
        ? meaningfulName(finalContact?.name)
        : meaningfulName(offer?.name ?? visitorName)

    return withCors(
      NextResponse.json(
        sessionBody({
          config,
          conversationId,
          level,
          hasPhone: !!finalContact?.phone,
          hasEmail: !!finalContact?.email,
          displayName,
          identityError,
          claimFound,
        }),
      ),
      corsOrigin,
    )
  } catch (err) {
    console.error('[widget/session] unexpected error:', err)
    return widgetError(500, 'Internal server error', undefined, corsOrigin)
  }
}
