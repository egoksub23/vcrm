// ============================================================
// POST /api/widget/verify-code
//
// Confirms a code POST /api/widget/session sent (migration 110, an
// email-code claim against a real, matched contact — see
// src/lib/widget/email-verification.ts). A correct code makes the
// browser `verified` (identity_source: 'code'), the same trust tier a
// signed in-app token gets, then follows the exact same
// guest-fold-in / conversation-ensure tail POST /api/widget/session
// uses for a successful identity.
//
// Public, CORS-enabled — but unlike every other widget route, the
// widgetToken/allowed_origins check can't happen before we know WHICH
// pending code row this visitor has, since that row is what names the
// account/config. An early auth failure (missing/bad bearer token) is
// therefore answered with no CORS headers, same as
// authenticateVisitorRequest's own early-auth failures in
// src/lib/widget/visitor-auth.ts.
// ============================================================
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { corsPreflight, resolveCorsOrigin, withCors } from '@/lib/widget/cors';
import { findOrCreatePrimaryConversation } from '@/lib/widget/session-identity';
import { meaningfulName } from '@/lib/widget/session-request';
import { sessionBody } from '@/lib/widget/session-response';
import {
  hashVerificationCode,
  MAX_VERIFICATION_ATTEMPTS,
} from '@/lib/widget/verification-code';
import {
  bearerToken,
  verifyVisitorJwt,
  widgetError,
  widgetRateLimited,
} from '@/lib/widget/visitor-auth';

export async function OPTIONS(request: Request) {
  return corsPreflight(request.headers.get('origin'));
}

export async function POST(request: Request) {
  const admin = supabaseAdmin();

  const jwt = bearerToken(request);
  if (!jwt) return widgetError(401, 'Missing Authorization bearer token');
  const visitorId = await verifyVisitorJwt(jwt);
  if (!visitorId) return widgetError(401, 'Invalid or expired session');

  const body = (await request.json().catch(() => null)) as {
    code?: unknown;
  } | null;
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  if (!/^\d{4,8}$/.test(code))
    return widgetError(400, 'Enter the code we sent you', 'bad_request');

  try {
    const { data: pending, error: pendingError } = await admin
      .from('widget_verification_codes')
      .select(
        'account_id, widget_config_id, contact_id, code_hash, attempts, expires_at'
      )
      .eq('widget_visitor_id', visitorId)
      .maybeSingle();
    if (pendingError) {
      console.error('[widget/verify-code] pending lookup error:', pendingError);
      return widgetError(500, 'Internal server error');
    }

    const { data: config } = pending
      ? await admin
          .from('web_widget_config')
          .select(
            'id, account_id, enabled, allowed_origins, name, welcome_message, primary_color, avatar_url, position, verification_mode'
          )
          .eq('id', pending.widget_config_id)
          .maybeSingle()
      : { data: null };

    if (!pending || !config || !config.enabled) {
      return widgetError(
        400,
        'No verification in progress. Request a new code.',
        'not_found'
      );
    }

    const corsOrigin = resolveCorsOrigin(
      request.headers.get('origin'),
      config.allowed_origins ?? []
    );
    if (!corsOrigin)
      return widgetError(403, 'Origin not allowed for this widget');

    const limit = checkRateLimit(
      `widget:verifycode:${visitorId}`,
      RATE_LIMITS.widgetVerifyCode
    );
    if (!limit.success) return widgetRateLimited(limit, corsOrigin);

    if (new Date(pending.expires_at).getTime() < Date.now()) {
      await admin
        .from('widget_verification_codes')
        .delete()
        .eq('widget_visitor_id', visitorId);
      return widgetError(
        400,
        'That code has expired. Request a new one.',
        'bad_request',
        corsOrigin
      );
    }

    if (pending.attempts >= MAX_VERIFICATION_ATTEMPTS) {
      await admin
        .from('widget_verification_codes')
        .delete()
        .eq('widget_visitor_id', visitorId);
      return widgetError(
        400,
        'Too many attempts. Request a new code.',
        'bad_request',
        corsOrigin
      );
    }

    if (hashVerificationCode(code) !== pending.code_hash) {
      await admin
        .from('widget_verification_codes')
        .update({ attempts: pending.attempts + 1 })
        .eq('widget_visitor_id', visitorId);
      return widgetError(400, 'Incorrect code', 'bad_request', corsOrigin);
    }

    // Correct: consume the code before doing anything else, so a
    // retried/duplicate request can't replay it.
    await admin
      .from('widget_verification_codes')
      .delete()
      .eq('widget_visitor_id', visitorId);

    let ownerUserId: string;
    try {
      ownerUserId = await resolveAuditUserId(admin, config.account_id);
    } catch (err) {
      if (err instanceof ContactError)
        return widgetError(err.status, err.message, undefined, corsOrigin);
      throw err;
    }

    // Fold the browser's own guest contact (if any) into the now-verified
    // one — same rule every other identity path uses: a guest is always
    // absorbed into whatever real contact the browser turns out to be.
    const { data: knownVisitor } = await admin
      .from('widget_visitors')
      .select('contact_id, identity_level')
      .eq('id', visitorId)
      .maybeSingle();
    if (
      knownVisitor &&
      knownVisitor.contact_id !== pending.contact_id &&
      knownVisitor.identity_level === 'guest'
    ) {
      const { error: mergeErr } = await admin.rpc(
        'merge_widget_guest_contact',
        {
          p_account_id: config.account_id,
          p_guest_contact_id: knownVisitor.contact_id,
          p_target_contact_id: pending.contact_id,
        }
      );
      if (mergeErr)
        console.error('[widget/verify-code] guest merge failed:', mergeErr);
    }

    const conversationId = await findOrCreatePrimaryConversation(
      admin,
      config.account_id,
      ownerUserId,
      pending.contact_id
    );

    const verifiedAt = new Date().toISOString();
    await admin.from('widget_visitors').upsert(
      {
        id: visitorId,
        account_id: config.account_id,
        contact_id: pending.contact_id,
        widget_config_id: config.id,
        last_seen_at: verifiedAt,
        identity_level: 'verified',
        identity_source: 'code',
        identity_verified_at: verifiedAt,
      },
      { onConflict: 'id' }
    );

    const { data: finalContact } = await admin
      .from('contacts')
      .select('name, phone, email')
      .eq('id', pending.contact_id)
      .maybeSingle();

    return withCors(
      NextResponse.json(
        sessionBody({
          config,
          conversationId,
          level: 'verified',
          hasPhone: !!finalContact?.phone,
          hasEmail: !!finalContact?.email,
          displayName: meaningfulName(finalContact?.name),
          claimFound: true,
        })
      ),
      corsOrigin
    );
  } catch (err) {
    console.error('[widget/verify-code] unexpected error:', err);
    return widgetError(500, 'Internal server error');
  }
}
