import { supabaseAdmin } from '@/lib/flows/admin-client';

import type { EmailIdentity } from './resend';

interface IdentityRow {
  name?: string | null;
  brand_name?: string | null;
  email_sender_name?: string | null;
  email_reply_to?: string | null;
}

/**
 * A workspace's outgoing-mail identity: the sender name they set, else their
 * product name, else their company name; and their reply-to if they set one.
 * Pure, so it is testable without a database.
 */
export function resolveEmailIdentity(row: IdentityRow | null | undefined): EmailIdentity {
  if (!row) return {};
  const pick = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  return {
    fromName: pick(row.email_sender_name) ?? pick(row.brand_name) ?? pick(row.name),
    replyTo: pick(row.email_reply_to),
  };
}

/**
 * Reads the identity for `accountId`. Never throws: a failed read (or migration
 * 143 not applied yet) means the mail goes out under the deployment's plain
 * sender, which is better than not sending a verification code.
 */
export async function loadEmailIdentity(accountId: string): Promise<EmailIdentity> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .select('name, brand_name, email_sender_name, email_reply_to')
      .eq('id', accountId)
      .maybeSingle();
    if (error) throw error;
    return resolveEmailIdentity(data as IdentityRow | null);
  } catch (err) {
    console.error('[email identity] could not load for account', accountId, err instanceof Error ? err.message : err);
    return {};
  }
}
