// ============================================================
// Starting an email-code verification (migration 110) for a typed
// claim on POST /api/widget/session, when
// web_widget_config.verification_mode === 'email_code'.
//
// Deliberately does NOT go through resolveIdentityContact /
// identity-resolve.ts: that path CREATES a contact when nothing
// matches (fine for an unverified claim, but wrong here — the whole
// point of this mode is "must be a registered phone/email", so an
// unmatched claim gets no code and no side effect at all, not a new
// contact). Only a real match with an email on file gets a code; the
// contact is otherwise untouched until POST /api/widget/verify-code
// actually confirms it.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js';

import { sendVerificationCodeEmail } from '@/lib/email/widget-verification-email';
import { createSupabaseIdentityStore } from './identity-resolve';
import {
  generateVerificationCode,
  hashVerificationCode,
  maskEmail,
  VERIFICATION_CODE_TTL_MS,
} from './verification-code';

export type StartEmailCodeResult =
  { ok: true; maskedEmail: string } | { ok: false };

export async function startEmailCodeVerification(
  admin: SupabaseClient,
  args: {
    accountId: string;
    widgetConfigId: string;
    widgetName: string;
    visitorId: string;
    phone: string | null;
    email: string | null;
  }
): Promise<StartEmailCodeResult> {
  const store = createSupabaseIdentityStore(admin);
  const phoneMatch = args.phone
    ? await store.findByPhone(args.accountId, args.phone)
    : null;
  const emailMatch =
    !phoneMatch && args.email
      ? await store.findByEmail(args.accountId, args.email)
      : null;
  const candidate = phoneMatch ?? emailMatch;

  // No match, or matched but nothing to verify through: no code, no
  // contact created, no trace left. The caller falls back to the
  // "we could not find that" state.
  if (!candidate?.email) return { ok: false };

  const code = generateVerificationCode();
  const { error } = await admin.from('widget_verification_codes').upsert(
    {
      widget_visitor_id: args.visitorId,
      account_id: args.accountId,
      widget_config_id: args.widgetConfigId,
      contact_id: candidate.id,
      destination_email: candidate.email,
      code_hash: hashVerificationCode(code),
      attempts: 0,
      expires_at: new Date(Date.now() + VERIFICATION_CODE_TTL_MS).toISOString(),
    },
    { onConflict: 'widget_visitor_id' }
  );
  if (error) throw error;

  await sendVerificationCodeEmail({
    to: candidate.email,
    code,
    widgetName: args.widgetName,
  });
  return { ok: true, maskedEmail: maskEmail(candidate.email) };
}
