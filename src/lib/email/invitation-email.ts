import { isResendConfigured, sendEmail } from './resend';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getValidAccessToken, type EmailConfigRow } from '@/lib/ms365/token';
import { sendNewMail } from '@/lib/ms365/mail-api';
import { GraphApiError } from '@/lib/ms365/errors';

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
 * Sends the invite email, trying Resend first (if configured) and
 * falling back to the account's own connected Microsoft 365 mailbox
 * (Settings → Channels → Email) when Resend isn't set up — reuses the
 * same channel customer replies already go out through rather than
 * requiring a second, dedicated transactional-email setup. Returns
 * `false` (never throws) when NEITHER sender is usable — the caller
 * falls back to today's "share the link yourself" flow rather than
 * failing invite creation over an optional feature. Throws if a
 * sender IS usable but the send itself fails, so the caller can tell
 * "no mail sender set up" apart from "sender set up but broken right
 * now".
 */
export async function sendInvitationEmail(args: {
  to: string;
  accountId: string;
  accountName: string;
  role: string;
  url: string;
  expiresInDays: number;
}): Promise<boolean> {
  const { subject, html, text } = buildInvitationEmail(args);

  if (isResendConfigured()) {
    await sendEmail({ to: args.to, subject, html, text });
    return true;
  }

  return sendViaConnectedMailbox({ accountId: args.accountId, to: args.to, subject, html, text });
}

/**
 * Fallback sender for accounts with no Resend key set. Returns false
 * only when no mailbox is connected at all, or it needs reauth (a
 * dead/revoked token) — those are the only "not usable right now"
 * states. Deliberately ignores `email_config.enabled`: that flag is
 * the channel's "pause without disconnecting" switch (migration 097,
 * see `ChannelEnabledSwitch`) for the *customer-facing* side — pulling
 * inbound mail into the Inbox and letting agents reply through it. A
 * paused channel still has a perfectly live OAuth connection, and an
 * admin who disables it specifically to stop it acting as a support
 * channel still wants it usable for the app's own internal sends
 * (like this one) — so this check is narrower than send-message.ts's
 * customer-facing send path on purpose, not an oversight. On an auth
 * failure mid-send, flips `needs_reauth` the same way that path does
 * before rethrowing.
 */
async function sendViaConnectedMailbox(args: {
  accountId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<boolean> {
  const admin = supabaseAdmin();
  const { data: cfg } = await admin
    .from('email_config')
    .select('*')
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (!cfg || cfg.needs_reauth) return false;

  try {
    const accessToken = await getValidAccessToken(cfg as EmailConfigRow);
    await sendNewMail({
      accessToken,
      toAddress: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
    return true;
  } catch (err) {
    if (err instanceof GraphApiError && err.isAuthError) {
      await admin.from('email_config').update({ needs_reauth: true }).eq('id', cfg.id);
    }
    throw err;
  }
}
