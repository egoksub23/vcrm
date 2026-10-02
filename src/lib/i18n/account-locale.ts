import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveLocale, type SupportedLocale } from './locales'

/**
 * The language a workspace's automated text (AI replies, summaries, drafted
 * tickets) is written in when nothing says otherwise: the workspace's own
 * setting (migration 144), else the deployment default, else English. Never
 * throws; any read problem means the deployment default.
 */
export async function loadAccountLocale(db: SupabaseClient, accountId: string): Promise<SupportedLocale> {
  const deployment = process.env.NEXT_PUBLIC_APP_LOCALE
  try {
    const { data } = await db.from('accounts').select('locale').eq('id', accountId).maybeSingle()
    return resolveLocale({ account: (data as { locale?: string | null } | null)?.locale, deployment })
  } catch {
    return resolveLocale({ deployment })
  }
}
