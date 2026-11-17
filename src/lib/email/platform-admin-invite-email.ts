// ============================================================
// Invitation email sent by the platform operator console when
// creating a new workspace and additional admin emails are specified.
// Sent via the platform sender (Resend), same as tenant-welcome-email.ts.
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

export function buildPlatformAdminInviteEmail(args: {
  companyName: string;
  url: string;
  expiresInDays: number;
}): { subject: string; html: string; text: string } {
  const subject = `You're invited to manage ${args.companyName} on Halo`;
  const text = [
    `You've been invited to join ${args.companyName} as a Workspace Admin on Halo.`,
    '',
    `Accept the invite: ${args.url}`,
    '',
    `This link expires in ${args.expiresInDays} day${args.expiresInDays === 1 ? '' : 's'}.`,
    '',
    'If you use a Google or Microsoft work account, signing in with it on that page will place you into the workspace automatically.',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <p style="font-size: 15px; line-height: 1.5;">
        You've been invited to join <strong>${escapeHtml(args.companyName)}</strong> as a <strong>Workspace Admin</strong> on Halo.
      </p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(args.url)}" style="display: inline-block; background: #4f46e5; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 600;">
          Accept invitation
        </a>
      </p>
      <p style="font-size: 13px; color: #666; line-height: 1.5;">
        This link expires in ${args.expiresInDays} day${args.expiresInDays === 1 ? '' : 's'}.
        If you use a Google or Microsoft work account, signing in with it on that page
        will place you into the workspace automatically.
      </p>
    </div>
  `.trim();

  return { subject, html, text };
}

/** Returns true when the email was handed to the provider. Never throws. */
export async function sendPlatformAdminInviteEmail(args: {
  to: string;
  companyName: string;
  url: string;
  expiresInDays: number;
}): Promise<boolean> {
  if (!isResendConfigured()) return false;
  try {
    const { subject, html, text } = buildPlatformAdminInviteEmail(args);
    await sendEmail({ to: args.to, subject, html, text });
    return true;
  } catch (err) {
    console.error('[platform-admin-invite-email] send failed:', err instanceof Error ? err.message : err);
    return false;
  }
}
