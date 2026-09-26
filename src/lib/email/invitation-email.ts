import { isResendConfigured, sendEmail } from './resend';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'admin',
  agent: 'agent',
  viewer: 'viewer',
};

function buildInvitationEmail(args: {
  accountName: string;
  role: string;
  url: string;
  expiresInDays: number;
}): { subject: string; html: string; text: string } {
  const roleLabel = ROLE_LABEL[args.role] ?? args.role;
  const subject = `You've been invited to join ${args.accountName}`;
  const text = [
    `You've been invited to join ${args.accountName} as ${roleLabel}.`,
    '',
    `Accept the invite: ${args.url}`,
    '',
    `This link expires in ${args.expiresInDays} day${args.expiresInDays === 1 ? '' : 's'}.`,
    '',
    'If you use a Google or Microsoft work account, signing in with it on that page will place you into the account automatically.',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <p style="font-size: 15px; line-height: 1.5;">
        You've been invited to join <strong>${escapeHtml(args.accountName)}</strong> as <strong>${escapeHtml(roleLabel)}</strong>.
      </p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(args.url)}" style="display: inline-block; background: #4f46e5; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 600;">
          Accept invitation
        </a>
      </p>
      <p style="font-size: 13px; color: #666; line-height: 1.5;">
        This link expires in ${args.expiresInDays} day${args.expiresInDays === 1 ? '' : 's'}. If you use a Google or Microsoft work account, signing in with it on that page will place you into the account automatically.
      </p>
      <p style="font-size: 12px; color: #999; word-break: break-all;">
        ${escapeHtml(args.url)}
      </p>
    </div>
  `.trim();

  return { subject, html, text };
}

/**
 * Sends the invite email via Resend. Returns `false` (never throws)
 * when Resend isn't configured — the caller falls back to today's
 * "share the link yourself" flow rather than failing invite creation
 * over an optional feature. Throws `ResendApiError` if Resend IS
 * configured but the send itself fails, so the caller can tell "no
 * mail sender set up" apart from "sender set up but broken right now".
 */
export async function sendInvitationEmail(args: {
  to: string;
  accountName: string;
  role: string;
  url: string;
  expiresInDays: number;
}): Promise<boolean> {
  if (!isResendConfigured()) return false;

  const { subject, html, text } = buildInvitationEmail(args);
  await sendEmail({ to: args.to, subject, html, text });
  return true;
}
