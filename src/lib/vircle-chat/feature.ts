import type { PgDb } from '@/lib/postgres/db'

import { isFeatureEnabled, parsePlatformRow } from '@/lib/platform/features'

export const VIRCLE_CHAT_FEATURE = 'vircle_chat'

/**
 * True when the operator has Vircle Chat switched on for the workspace (and the
 * workspace is not suspended). A missing row reads as enabled, like every flag.
 * For server routes that act outside a signed-in session (the webhook, the
 * send path); the browser reads the same flag from the auth context.
 */
export async function vircleChatEnabled(admin: PgDb, accountId: string): Promise<boolean> {
  const { data, error } = await admin.from('account_platform').select('*').eq('account_id', accountId).maybeSingle()
  if (error) throw new Error(error.message)
  const platform = parsePlatformRow(data)
  return platform.status === 'active' && isFeatureEnabled(platform, VIRCLE_CHAT_FEATURE)
}
