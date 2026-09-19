/**
 * Validation for the contact fields edited inline in the Inbox's contact
 * column. Pure so it is unit-tested; the component only wires it to
 * inputs and the Supabase write.
 */

export type FieldCheck<T> = { ok: true; value: T } | { ok: false; reason: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_CHARS_RE = /^\+?[\d\s().-]+$/;

/** A blank email clears the field (value null); otherwise it must look like an address. */
export function checkEmail(raw: string): FieldCheck<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > 254 || !EMAIL_RE.test(value)) return { ok: false, reason: 'email_invalid' };
  return { ok: true, value };
}

/**
 * A phone number as typed: digits with an optional leading + and the
 * usual separators, 7–15 digits (E.164 upper bound). Formatting is kept
 * as typed — the DB derives the digits-only key itself. A blank phone is
 * only allowed when the contact is identified some other way (BSUID,
 * Messenger, Instagram, widget), since `phone` is otherwise their key.
 */
export function checkPhone(raw: string, opts: { canBeEmpty: boolean }): FieldCheck<string> {
  const value = raw.trim().replace(/\s+/g, ' ');
  if (!value) {
    return opts.canBeEmpty ? { ok: true, value: '' } : { ok: false, reason: 'phone_required' };
  }
  if (!PHONE_CHARS_RE.test(value)) return { ok: false, reason: 'phone_invalid' };
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return { ok: false, reason: 'phone_invalid' };
  return { ok: true, value };
}

/** True when the contact has an identity other than a phone number. */
export function hasNonPhoneIdentity(c: {
  wa_user_id?: string | null;
  messenger_psid?: string | null;
  instagram_igsid?: string | null;
  widget_visitor_id?: string | null;
}): boolean {
  return !!(c.wa_user_id || c.messenger_psid || c.instagram_igsid || c.widget_visitor_id);
}

/** Free text (name, company): trimmed, blank → null, capped. */
export function checkText(raw: string, max = 120): FieldCheck<string | null> {
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > max) return { ok: false, reason: 'too_long' };
  return { ok: true, value };
}
