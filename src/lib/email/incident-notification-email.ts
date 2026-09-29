import { isResendConfigured, sendEmail } from './resend';
import { supabaseAdmin } from '@/lib/flows/admin-client';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type IncidentEmailKind = 'raised' | 'escalated' | 'assigned';

const KIND_VERB: Record<IncidentEmailKind, string> = {
  raised: 'was raised',
  escalated: 'was escalated',
  assigned: 'was assigned to you',
};

function buildIncidentEmail(args: {
  kind: IncidentEmailKind;
  key: string;
  title: string;
  severity: string;
  detail?: string;
  url: string;
}): { subject: string; html: string; text: string } {
  const subject = `[${args.severity}] ${args.key} ${KIND_VERB[args.kind]}`;
  const detailLine = args.detail ? `${args.detail}\n\n` : '';
  const text = [
    `${args.key} (${args.severity}) — ${args.title}`,
    '',
    `${detailLine}Open it in Vircle Halo: ${args.url}`,
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
      <p style="font-size: 15px; line-height: 1.5;">
        <strong>${escapeHtml(args.key)}</strong> (${escapeHtml(args.severity)}) — ${escapeHtml(args.title)}
      </p>
      ${args.detail ? `<p style="font-size: 14px; line-height: 1.5; color: #333;">${escapeHtml(args.detail)}</p>` : ''}
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(args.url)}" style="display: inline-block; background: #B42318; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 600;">
          Open incident
        </a>
      </p>
      <p style="font-size: 12px; color: #999; word-break: break-all;">
        ${escapeHtml(args.url)}
      </p>
    </div>
  `.trim();

  return { subject, html, text };
}

/**
 * Best-effort email for one incident notification — never throws.
 * Resend is the only sender here (unlike invitation-email.ts's MS365
 * fallback): incident notifications are a supplementary channel on top
 * of the in-app notification, which always lands regardless, so an
 * unconfigured or failing send is logged and dropped rather than
 * chased with a fallback sender.
 */
export async function sendIncidentNotificationEmail(args: {
  to: string;
  kind: IncidentEmailKind;
  key: string;
  title: string;
  severity: string;
  detail?: string;
  incidentId: string;
  appBaseUrl: string;
}): Promise<void> {
  if (!isResendConfigured()) return;

  const url = `${args.appBaseUrl.replace(/\/$/, '')}/incidents/${args.incidentId}`;
  const { subject, html, text } = buildIncidentEmail({
    kind: args.kind,
    key: args.key,
    title: args.title,
    severity: args.severity,
    detail: args.detail,
    url,
  });

  try {
    await sendEmail({ to: args.to, subject, html, text });
  } catch (err) {
    console.error(`[incident-notification-email] send failed for incident ${args.incidentId}:`, err);
  }
}

/**
 * Emails every user_id in `userIds` about one incident event, best-effort
 * and in parallel — a bad address or a down Resend never blocks the
 * caller (the raise route, the escalation cron, the manual-escalate
 * route). Looks up each recipient's email from `profiles` (service role
 * — bypasses RLS, which is fine here since the recipients were already
 * chosen by the SQL side, which is the actual authorization boundary).
 */
export async function notifyIncidentEmail(args: {
  userIds: readonly string[];
  kind: IncidentEmailKind;
  key: string;
  title: string;
  severity: string;
  detail?: string;
  incidentId: string;
  appBaseUrl: string;
}): Promise<void> {
  if (!isResendConfigured() || args.userIds.length === 0) return;

  const admin = supabaseAdmin();
  const { data: profiles } = await admin
    .from('profiles')
    .select('user_id, email')
    .in('user_id', args.userIds);

  const emails = (profiles ?? [])
    .map((p) => (p as { email: string | null }).email)
    .filter((e): e is string => Boolean(e));

  await Promise.allSettled(
    emails.map((to) =>
      sendIncidentNotificationEmail({
        to,
        kind: args.kind,
        key: args.key,
        title: args.title,
        severity: args.severity,
        detail: args.detail,
        incidentId: args.incidentId,
        appBaseUrl: args.appBaseUrl,
      }),
    ),
  );
}
