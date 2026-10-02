/**
 * Thin Resend REST client — plain `fetch()`, no SDK dependency, matching
 * the convention every other external API integration in this codebase
 * follows (`src/lib/whatsapp/meta-api.ts`, `src/lib/ms365/mail-api.ts`,
 * `src/lib/gmail/*`): named-params-object functions, a small typed error
 * class, no vendor SDK weight added to the app.
 *
 * The API key and the sending ADDRESS are global (`RESEND_API_KEY` /
 * `RESEND_FROM_EMAIL`, same tier as `META_APP_SECRET`): an address can only be
 * sent as once its domain is verified with Resend. What a workspace controls is
 * the display name and reply-to (accounts.email_sender_name / email_reply_to,
 * migration 143), passed per send; see lib/email/identity.ts. Mail sent as the
 * platform itself (a new customer's welcome) passes neither.
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

/** What a workspace's outgoing mail looks like to the person receiving it. */
export interface EmailIdentity {
  /** Display name shown next to the address. */
  fromName?: string | null;
  /** Where replies go. */
  replyTo?: string | null;
}

const UNSAFE_NAME_CHARS = /[\r\n"<>;,]/g;
const PLAIN_EMAIL = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;

/**
 * The `From` header: the deployment's verified address (the only address mail
 * can be sent as without verifying another domain) under the workspace's
 * display name. An address configured as `Name <addr>` keeps only its address
 * when a workspace name is given. Unsafe characters are dropped, never quoted:
 * a name can never alter the address or add a header.
 */
export function formatFrom(configured: string, fromName?: string | null): string {
  const name = (fromName ?? '').replace(UNSAFE_NAME_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) return configured;
  const bare = configured.match(/<([^<>]+)>\s*$/)?.[1]?.trim() ?? configured.trim();
  return `${name} <${bare}>`;
}

/** The reply-to address if it is one plain address, otherwise nothing. */
export function safeReplyTo(replyTo?: string | null): string | undefined {
  const v = replyTo?.trim();
  return v && v.length <= 254 && PLAIN_EMAIL.test(v) ? v : undefined;
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
} & EmailIdentity): Promise<void> {
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
      from: formatFrom(fromAddress(), args.fromName),
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
      ...(safeReplyTo(args.replyTo) ? { reply_to: safeReplyTo(args.replyTo) } : {}),
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
