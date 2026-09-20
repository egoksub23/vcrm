import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { MetaApiError } from '@/lib/meta/errors'
import { getGrantedPermissions, subscribePageFields } from './meta-comments'

export type EnableCommentsResult =
  | { ok: true; fields: string[] }
  | { ok: false; status: number; error: string; reconnect?: boolean }

/**
 * Turn on comments for a connected Messenger / Instagram channel.
 *
 * Facebook: subscribe the Page to `feed`, keeping whatever it is already
 * subscribed to.
 *
 * Instagram: `comments` / `live_comments` are NOT valid Page fields (Meta
 * rejects them). They are app-level webhook fields, switched on once in the
 * Meta dashboard under the Instagram object, so here we only confirm the
 * admin granted the comment permission when they reconnected.
 *
 * Both need permissions that are only granted if the admin reconnected with
 * "Allow comments".
 */
export async function enableChannelComments(
  db: SupabaseClient,
  accountId: string,
  provider: 'facebook' | 'instagram',
): Promise<EnableCommentsResult> {
  const table = provider === 'facebook' ? 'messenger_config' : 'instagram_config'
  const { data: cfg } = await db
    .from(table)
    .select('page_id, page_access_token, long_lived_user_token')
    .eq('account_id', accountId)
    .eq('status', 'connected')
    .maybeSingle()
  if (!cfg) {
    return { ok: false, status: 409, error: `${provider === 'facebook' ? 'Messenger' : 'Instagram'} is not connected yet.` }
  }

  try {
    let fields: string[]
    if (provider === 'facebook') {
      fields = await subscribePageFields({
        pageId: cfg.page_id as string,
        token: decrypt(cfg.page_access_token as string),
        add: ['feed'],
      })
    } else {
      const userToken = cfg.long_lived_user_token as string | null
      if (!userToken) {
        return { ok: false, status: 409, error: 'Reconnect Instagram with "Allow comments" first.', reconnect: true }
      }
      const granted = await getGrantedPermissions({ token: decrypt(userToken) })
      if (!granted.includes('instagram_manage_comments')) {
        return {
          ok: false,
          status: 409,
          error: 'Instagram comment permission was not granted. Use "Allow comments (reconnect)" and approve every permission.',
          reconnect: true,
        }
      }
      fields = ['comments', 'live_comments']
    }
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
