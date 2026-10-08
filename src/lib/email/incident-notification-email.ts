import { realWorkspaceMailDeps, sendWorkspaceEmail, type WorkspaceMailDeps } from './workspace-mail';
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

/** What the senders in this file need: the shared workspace mail dependencies, and the lookup of who to email. */
export interface IncidentEmailDeps {
  mail: WorkspaceMailDeps;
  /** The address and workspace of each person (service role: the recipients were already chosen by the SQL side, which is the authorization boundary). */
  loadRecipients: (userIds: readonly string[]) => Promise<{ email: string | null; account_id: string | null }[]>;
}

export const realIncidentEmailDeps: IncidentEmailDeps = {
  mail: realWorkspaceMailDeps,
  loadRecipients: async (userIds) => {
    const { data } = await supabaseAdmin().from('profiles').select('user_id, email, account_id').in('user_id', userIds as string[]);
    return (data ?? []) as { email: string | null; account_id: string | null }[];
  },
};

/**
 * Best-effort email for one incident notification, sent as the person's workspace by the shared workspace sender: through the workspace's connected
 * mailbox when it has one that can send, else the platform sender (Resend). Never throws. Incident notifications are a supplementary channel on top of
 * the in-app notification, which always lands regardless, so a workspace with no way to send, or a failing send, is logged and dropped rather than
 * chased with another sender.
 */
export async function sendIncidentNotificationEmail(
  args: {
    to: string;
    /** The workspace the recipient belongs to: its mailbox and sender name are used. */
    accountId: string;
    kind: IncidentEmailKind;
    key: string;
    title: string;
    severity: string;
    detail?: string;
    incidentId: string;
    appBaseUrl: string;
  },
  deps: WorkspaceMailDeps = realWorkspaceMailDeps,
): Promise<void> {
  const url = `${args.appBaseUrl.replace(/\/$/, '')}/incidents/${args.incidentId}`;
  try {
    const { subject, html, text } = buildIncidentEmail({
      kind: args.kind,
      key: args.key,
      title: args.title,
      severity: args.severity,
      detail: args.detail,
      url,
    });
    const result = await sendWorkspaceEmail(args.accountId, { to: args.to, subject, html, text }, deps);
    if (result.status === 'failed') {
      console.error(`[incident-notification-email] send failed for incident ${args.incidentId}:`, result.detail);
    }
  } catch (err) {
    console.error(`[incident-notification-email] send failed for incident ${args.incidentId}:`, err);
  }
}

/**
 * Emails every user_id in `userIds` about one incident event, best-effort
 * and in parallel — a bad address or a down mail service never blocks the
 * caller (the raise route, the escalation cron, the manual-escalate
 * route). Each recipient is emailed as their own workspace (their profile
 * says which), so the mailbox that sends is that workspace's.
 */
export async function notifyIncidentEmail(
  args: {
    userIds: readonly string[];
    kind: IncidentEmailKind;
    key: string;
    title: string;
    severity: string;
    detail?: string;
    incidentId: string;
    appBaseUrl: string;
  },
  deps: IncidentEmailDeps = realIncidentEmailDeps,
): Promise<void> {
  if (args.userIds.length === 0) return;

  const recipients = (await deps.loadRecipients(args.userIds)).filter(
    (p): p is { email: string; account_id: string } => Boolean(p.email) && Boolean(p.account_id),
  );

  await Promise.allSettled(
    recipients.map((p) =>
      sendIncidentNotificationEmail(
        {
          to: p.email,
          accountId: p.account_id,
          kind: args.kind,
          key: args.key,
          title: args.title,
          severity: args.severity,
          detail: args.detail,
          incidentId: args.incidentId,
          appBaseUrl: args.appBaseUrl,
        },
        deps.mail,
      ),
    ),
  );
}
