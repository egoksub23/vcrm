// ============================================================
// Pure helpers for the web widget's email-code verification
// (migration 110). No I/O — the code itself, its hash for storage,
// and masking an email for display all belong here so they are
// independently unit-testable, same convention as identity-token.ts.
// ============================================================
import { createHash, randomInt } from 'node:crypto';

export const VERIFICATION_CODE_TTL_MS = 10 * 60_000;
export const MAX_VERIFICATION_ATTEMPTS = 5;

/** A 6-digit numeric code, zero-padded (e.g. "004821"). */
export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashVerificationCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** "j***@example.com" — enough for a visitor to recognise their own
 *  inbox without exposing the full address to whoever is at the
 *  keyboard (the claim itself may have been someone else's typo or
 *  guess). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(local.length - 1, 3))}@${domain}`;
}
