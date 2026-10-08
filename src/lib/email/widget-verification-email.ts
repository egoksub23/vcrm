import { technicalOfDetail } from './send-reason';
import { realWorkspaceMailDeps, sendWorkspaceEmail, type WorkspaceMailDeps } from './workspace-mail';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sends the widget's email-verification code (migration 110). Unlike
 * `sendInvitationEmail`, this is not best-effort: the caller only
 * reaches this once it has already decided email-code verification is
 * both configured and the right channel, so a failure here should
 * propagate as a real error, not be swallowed.
 *
 * The code comes from the workspace the widget belongs to, so it goes out
 * by the shared workspace sender (lib/email/workspace-mail.ts): the
 * workspace's connected mailbox when it has one that can send, else the
 * platform sender (Resend). Without a workspace there is only the
 * platform sender.
 */
export async function sendVerificationCodeEmail(
  args: {
    to: string;
    code: string;
    /** The widget's own display name (Settings → Channels → Web Widget),
     *  not the CRM account's name — this is what the visitor recognizes. */
    widgetName: string;
    /** The workspace the widget belongs to: its mailbox, sender name and reply-to are used. */
    accountId?: string;
  },
  deps: WorkspaceMailDeps = realWorkspaceMailDeps,
): Promise<void> {
  const subject = `Your verification code: ${args.code}`;
  const text = [
    `Your verification code for ${args.widgetName} chat is: ${args.code}`,
    '',
    'This code expires in 10 minutes. If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <p style="font-size: 15px; line-height: 1.5;">
        Your verification code for <strong>${escapeHtml(args.widgetName)}</strong> chat is:
      </p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; margin: 16px 0; font-family: monospace;">
        ${escapeHtml(args.code)}
      </p>
      <p style="font-size: 13px; color: #666; line-height: 1.5;">
        This code expires in 10 minutes. If you did not request this, you can ignore this email.
      </p>
    </div>
  `.trim();

  if (!args.accountId) {
    await deps.sendEmail({ to: args.to, subject, html, text });
    return;
  }
  const result = await sendWorkspaceEmail(args.accountId, { to: args.to, subject, html, text }, deps);
  if (result.status !== 'sent') throw new Error(technicalOfDetail(result.detail) || result.detail || 'send failed');
}
