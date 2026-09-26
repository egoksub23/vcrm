/**
 * Thin Resend REST client — plain `fetch()`, no SDK dependency, matching
 * the convention every other external API integration in this codebase
 * follows (`src/lib/whatsapp/meta-api.ts`, `src/lib/ms365/mail-api.ts`,
 * `src/lib/gmail/*`): named-params-object functions, a small typed error
 * class, no vendor SDK weight added to the app.
 *
 * Bring-your-own-key, global (not per-account): `RESEND_API_KEY` /
 * `RESEND_FROM_EMAIL` env vars, same tier as `META_APP_SECRET` or
 * `MS365_CLIENT_SECRET` — see .env.local.example. Deliberately NOT an
 * account setting like the WhatsApp/Gmail/MS365 channels: this only
 * ever sends the app's own transactional mail (invites today), never a
 * customer-facing message, so one deployment-wide sender identity is
 * the right scope, not one per account.
 */

export class ResendApiError extends Error {
  readonly httpStatus: number;

  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = 'ResendApiError';
    this.httpStatus = httpStatus;
  }
}

const RESEND_API_URL = 'https://api.resend.com/emails';

/** True when RESEND_API_KEY is set — callers use this to decide whether
 *  to attempt a send at all, so an unconfigured deployment degrades to
 *  today's "share the link yourself" behavior instead of throwing. */
export function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

function fromAddress(): string {
  const configured = process.env.RESEND_FROM_EMAIL?.trim();
  if (configured) return configured;
  // Resend's own shared sandbox sender — works without a verified
  // domain, but only ever delivers to the account's own verified
  // Resend login address. Fine as a zero-config default for a first
  // try; RESEND_FROM_EMAIL should be set to a verified domain address
  // for real use (see docs/sso-login-setup.md).
  return 'onboarding@resend.dev';
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new ResendApiError('RESEND_API_KEY is not configured', 0);
  }

  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      (body &&
      typeof body === 'object' &&
      'message' in body &&
      typeof body.message === 'string'
        ? body.message
        : null) ?? `Resend request failed: ${response.status}`;
    throw new ResendApiError(message, response.status);
  }
}
