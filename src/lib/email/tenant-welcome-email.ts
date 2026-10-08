// ============================================================
// "Your workspace is ready, set your password" email, sent by the
// platform operator console when it creates a customer workspace
// (src/app/api/platform/accounts/route.ts). Pure builder + a best-effort
// sender: with no RESEND_API_KEY it reports `false` and the console shows
// the one-time link to the operator instead.
//
// Deliberately NOT sent through the workspace-aware sender (workspace-mail.ts):
// this is platform mail, sent by the operator to a workspace that has just
// been created and cannot have connected a mailbox yet, so it always goes by
// the platform sender (Resend).
// ============================================================
import { isResendConfigured, sendEmail } from './resend';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildTenantWelcomeEmail(args: {
  companyName: string;
  ownerName: string | null;
  url: string;
}): { subject: string; html: string; text: string } {
  const greeting = args.ownerName ? `Hi ${args.ownerName},` : 'Hello,';
  const subject = `Your ${args.companyName} workspace is ready`;
  const text = [
    greeting,
    '',
    `A workspace for ${args.companyName} has been set up for you. Choose a password to sign in:`,
    '',
    args.url,
    '',
    'This link can be used once and expires after a short time. If it has expired, use "Forgot password" on the sign-in page.',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <p style="font-size: 15px; line-height: 1.5;">${escapeHtml(greeting)}</p>
      <p style="font-size: 15px; line-height: 1.5;">
        A workspace for <strong>${escapeHtml(args.companyName)}</strong> has been set up for you. Choose a password to sign in.
      </p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(args.url)}" style="display: inline-block; background: #4f46e5; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 600;">
          Set your password
        </a>
      </p>
      <p style="font-size: 13px; color: #666; line-height: 1.5;">
        This link can be used once and expires after a short time. If it has expired, use &ldquo;Forgot password&rdquo; on the sign-in page.
      </p>
    </div>
  `.trim();

  return { subject, html, text };
}

/** Returns true when the email was handed to the provider. Never throws. */
export async function sendTenantWelcomeEmail(args: {
  to: string;
  companyName: string;
  ownerName: string | null;
  url: string;
}): Promise<boolean> {
  if (!isResendConfigured()) return false;
  try {
    const { subject, html, text } = buildTenantWelcomeEmail(args);
    await sendEmail({ to: args.to, subject, html, text });
    return true;
  } catch (err) {
    console.error('[tenant-welcome-email] send failed:', err instanceof Error ? err.message : err);
    return false;
  }
}
