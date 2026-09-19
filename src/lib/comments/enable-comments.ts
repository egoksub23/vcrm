import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { MetaApiError } from '@/lib/meta/errors'
import { subscribePageFields } from './meta-comments'

export type EnableCommentsResult =
  | { ok: true; fields: string[] }
  | { ok: false; status: number; error: string; reconnect?: boolean }

/**
 * Subscribe the connected Page to comment events (Facebook: `feed`;
 * Instagram: `comments` + `live_comments`), keeping whatever it is already
 * subscribed to. Needs the comment permissions, which are only granted if
 * the admin reconnected with "Allow comments".
 */
export async function enableChannelComments(
  db: SupabaseClient,
  accountId: string,
  provider: 'facebook' | 'instagram',
): Promise<EnableCommentsResult> {
  const table = provider === 'facebook' ? 'messenger_config' : 'instagram_config'
  const { data: cfg } = await db
    .from(table)
    .select('page_id, page_access_token')
    .eq('account_id', accountId)
    .eq('status', 'connected')
    .maybeSingle()
  if (!cfg) {
    return { ok: false, status: 409, error: `${provider === 'facebook' ? 'Messenger' : 'Instagram'} is not connected yet.` }
  }

  try {
    const fields = await subscribePageFields({
      pageId: cfg.page_id as string,
      token: decrypt(cfg.page_access_token as string),
      add: provider === 'facebook' ? ['feed'] : ['comments', 'live_comments'],
    })
    await db.from(table).update({ comments_enabled_at: new Date().toISOString() }).eq('account_id', accountId)
    return { ok: true, fields }
  } catch (err) {
    if (err instanceof MetaApiError) {
      // 190 = the token is invalid; 10 / 200 = a permission is missing.
      const reconnect = err.code === 190 || err.code === 10 || err.code === 200
      return { ok: false, status: reconnect ? 409 : 502, error: err.message, reconnect }
    }
    throw err
  }
}
