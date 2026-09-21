// ============================================================
// POST /api/widget/enquiry
//
// The "I am new here" form of the widget: name, phone OR email, "I am a"
// (parent | school | merchant | other), a message, and a consent tick.
//
// What it does:
//   - matches or creates the contact with the SAME unverified rules as a
//     typed claim (never merges two real contacts; possible duplicates are
//     suggested to agents instead), folding the visitor's own guest contact
//     into it. A browser that is already VERIFIED keeps its verified
//     contact: a typed form never re-identifies a verified visitor.
//   - a new contact is a lead (lifecycle_stage 'lead') and gets the tags
//     "Web enquiry" and "Enquiry: <role>" (an existing contact gets the
//     tags too, so agents can see this came from the enquiry form)
//   - records a `widget_enquiries` row (consent time included)
//   - inserts the first customer message (a short header + the text) and
//     fires the SAME fan-out /api/widget/message fires: new_contact_created
//     for a new contact, first_inbound_message / new_message_received /
//     keyword_match automations, AI reply, outbound webhooks. The existing
//     routing (automations and assignment rules) therefore applies as is.
//
// Answers with the same body as /api/widget/session (with a conversationId,
// identity.level 'claimed' (or 'verified' for a verified browser)).
// Rate limited per visitor and per widget_token + origin.
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
import { enquiryMessageText, parseEnquiryBody } from '@/lib/widget/enquiry'
import {
  insertWidgetCustomerMessage,
  isFirstCustomerMessage,
  runWidgetInboundFanout,
} from '@/lib/widget/inbound'
import { meaningfulName } from '@/lib/widget/session-request'
import { sessionBody } from '@/lib/widget/session-response'
import { applyContactTagByName, enquiryRoleTag, WIDGET_TAG_ENQUIRY } from '@/lib/widget/tags'
import { bearerToken, verifyVisitorJwt, widgetError, widgetRateLimited } from '@/lib/widget/visitor-auth'

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'))
}

function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for') ?? ''
  return fwd.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown'
}

export async function POST(request: Request) {
  const requestOrigin = request.headers.get('origin')
  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null

  const widgetToken = typeof raw?.widgetToken === 'string' ? raw.widgetToken.trim() : ''
  if (!widgetToken) return widgetError(400, 'widgetToken is required', 'bad_request')

  const admin = supabaseAdmin()

  const { data: config, error: configError } = await admin
    .from('web_widget_config')
    .select(
      'id, account_id, enabled, allowed_origins, name, welcome_message, primary_color, avatar_url, position, verification_mode',
    )
    .eq('widget_token', widgetToken)
    .maybeSingle()
  if (configError) {
    console.error('[widget/enquiry] config lookup error:', configError)
    return widgetError(500, 'Internal server error')
  }
  if (!config || !config.enabled) return widgetError(404, 'Widget not found or disabled', 'not_found')

  const corsOrigin = resolveCorsOrigin(requestOrigin, config.allowed_origins ?? [])
  if (!corsOrigin) return widgetError(403, 'Origin not allowed for this widget')

  const jwt = bearerToken(request)
  if (!jwt) return widgetError(401, 'Missing Authorization bearer token', undefined, corsOrigin)
  const visitorId = await verifyVisitorJwt(jwt)
  if (!visitorId) return widgetError(401, 'Invalid or expired session', undefined, corsOrigin)

  const limits = [
    checkRateLimit(`widget:enquiry:${visitorId}`, RATE_LIMITS.widgetEnquiry),
    checkRateLimit(`widget:enquiry:o:${widgetToken}:${requestOrigin ?? 'unknown'}`, RATE_LIMITS.widgetEnquiryOrigin),
    checkRateLimit(`widget:identity:ip:${clientIp(request)}`, RATE_LIMITS.widgetIdentityIp),
  ]
  const blocked = limits.find((l) => !l.success)
  if (blocked) return widgetRateLimited(blocked, corsOrigin)

  const parsed = parseEnquiryBody(raw)
  if (!parsed.ok) return widgetError(400, parsed.error, parsed.code, corsOrigin)
  const enquiry = parsed.value

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
    const knownLevel = ((knownVisitor?.identity_level as IdentityLevel | undefined) ?? 'guest') as IdentityLevel

    let contactId: string | null = (knownVisitor?.contact_id as string | undefined) ?? null
    let contactCreated = false
    let claimFound = false
    let level: IdentityLevel = knownLevel
    let source: IdentitySource | null = (knownVisitor?.identity_source as IdentitySource | null) ?? null

    if (knownLevel === 'verified' && contactId) {
      // Keep the verified identity as is.
      claimFound = true
    } else {
      const result = await resolveIdentityContact(createSupabaseIdentityStore(admin), {
        accountId: config.account_id,
        ownerUserId,
        identity: { phone: enquiry.phone, email: enquiry.email, name: enquiry.name },
        verified: false,
      })
      claimFound = result.matched
      contactCreated = result.created

      if (contactId && contactId !== result.contactId && knownLevel === 'guest') {
        const { error: mergeErr } = await admin.rpc('merge_widget_guest_contact', {
          p_account_id: config.account_id,
          p_guest_contact_id: contactId,
          p_target_contact_id: result.contactId,
        })
        if (mergeErr) console.error('[widget/enquiry] guest merge failed:', mergeErr)
      }
      contactId = result.contactId
      level = maxLevel(knownLevel, 'claimed')
      source = source ?? 'typed'
    }

    if (!contactId) return widgetError(500, 'Failed to resolve contact', undefined, corsOrigin)

    if (contactCreated) {
      // A new contact is a lead (also the column default; explicit on purpose).
      await admin.from('contacts').update({ lifecycle_stage: 'lead' }).eq('id', contactId)
    }
    await applyContactTagByName(admin, {
      accountId: config.account_id,
      ownerUserId,
      contactId,
      name: WIDGET_TAG_ENQUIRY,
    })
    await applyContactTagByName(admin, {
      accountId: config.account_id,
      ownerUserId,
      contactId,
      name: enquiryRoleTag(enquiry.role),
    })

    const conversationId = await findOrCreatePrimaryConversation(admin, config.account_id, ownerUserId, contactId)

    await admin.from('widget_visitors').upsert(
      {
        id: visitorId,
        account_id: config.account_id,
        contact_id: contactId,
        widget_config_id: config.id,
        last_seen_at: new Date().toISOString(),
        identity_level: level,
        identity_source: source,
        identity_verified_at: (knownVisitor?.identity_verified_at as string | null) ?? null,
      },
      { onConflict: 'id' },
    )

    const { error: enquiryError } = await admin.from('widget_enquiries').insert({
      account_id: config.account_id,
      contact_id: contactId,
      conversation_id: conversationId,
      widget_visitor_id: visitorId,
      name: enquiry.name,
      phone: enquiry.phone,
      email: enquiry.email,
      role: enquiry.role,
      message: enquiry.message,
      locale: enquiry.locale,
      consent_at: new Date().toISOString(),
    })
    if (enquiryError) {
      console.error('[widget/enquiry] enquiry insert error:', enquiryError)
      return widgetError(500, 'Failed to save the enquiry', undefined, corsOrigin)
    }

    if (contactCreated) {
      await runAutomationsForTrigger({
        accountId: config.account_id,
        triggerType: 'new_contact_created',
        contactId,
        context: { conversation_id: conversationId },
      }).catch((err) => console.error('[widget/enquiry] new_contact_created dispatch failed:', err))
    }

    // The enquiry text is the visitor's first message in the conversation.
    const text = enquiryMessageText(enquiry.role, enquiry.message)
    const isFirstInboundMessage = await isFirstCustomerMessage(admin, conversationId)
    const inserted = await insertWidgetCustomerMessage(admin, { conversationId, text })
    if (!inserted) return widgetError(500, 'Failed to save the enquiry', undefined, corsOrigin)

    const { data: conversation } = await admin
      .from('conversations')
      .select('id, status')
      .eq('id', conversationId)
      .maybeSingle()

    await runWidgetInboundFanout(admin, {
      accountId: config.account_id,
      contactId,
      conversation: conversation ?? { id: conversationId },
      ownerUserId,
      messageId: inserted.id,
      text,
      isFirstInboundMessage,
      visitorId,
    })

    const { data: finalContact } = await admin
      .from('contacts')
      .select('name, phone, email')
      .eq('id', contactId)
      .maybeSingle()

    return withCors(
      NextResponse.json(
        sessionBody({
          config,
          conversationId,
          level,
          hasPhone: !!finalContact?.phone,
          hasEmail: !!finalContact?.email,
          // Only what the visitor typed just now, or a verified contact's own name.
          displayName: level === 'verified' ? meaningfulName(finalContact?.name) : meaningfulName(enquiry.name),
          claimFound,
        }),
      ),
      corsOrigin,
    )
  } catch (err) {
    console.error('[widget/enquiry] unexpected error:', err)
    return widgetError(500, 'Internal server error', undefined, corsOrigin)
  }
}
