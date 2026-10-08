// ============================================================
// Workspace teardown outside the database (part of workspace deletion, migration 153).
//
// Before a workspace's rows go, the things that live on other services and that
// this app set up for it are switched off, best effort, with the tokens that are
// about to be deleted:
//
//   WhatsApp           the app's subscription to the customer's WABA (the phone number
//                      stays registered: it is theirs)
//   Messenger, Instagram   the Page's subscription to this app
//   Gmail              the push watch (none while the mailbox is not used for the customer care inbox)
//   Microsoft 365      the mail subscription (none while the mailbox is not used for the customer care inbox)
//   Jira               the webhooks (and the stored tokens, links and sync history)
//
// Each result is recorded on the deletion tombstone. A failure never stops the
// deletion: a dead token usually means the other side has already dropped it, and
// the inbound handlers ignore events for a workspace that no longer exists.
// TikTok has no per-workspace registration to remove; Vircle Chat's side (the
// gateway) is removed with the gateway's own command (see docs).
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

import { unsubscribePage } from '@/lib/comments/meta-comments'
import { stopWatch } from '@/lib/gmail/gmail-api'
import { getValidAccessToken as gmailToken } from '@/lib/gmail/token'
import { inboxIsOff } from '@/lib/email/mailbox-types'
import { disconnect } from '@/lib/jira/connection'
import { isJiraConfigured } from '@/lib/jira/oauth'
import { clientForConnection, jiraStore } from '@/lib/jira/service'
import { deleteSubscription } from '@/lib/ms365/mail-api'
import { getValidAccessToken as ms365Token } from '@/lib/ms365/token'
import { decrypt } from '@/lib/whatsapp/encryption'
import { unsubscribeWabaFromApp } from '@/lib/whatsapp/meta-api'

export type TeardownResults = Record<string, string>

async function step(results: TeardownResults, name: string, run: () => Promise<string | void>): Promise<void> {
  try {
    results[name] = (await run()) ?? 'ok'
  } catch (err) {
    results[name] = `failed: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown error'}`
  }
}

/** Switch off every external registration for the workspace. Never throws. */
export async function teardownWorkspaceChannels(db: SupabaseClient, accountId: string): Promise<TeardownResults> {
  const results: TeardownResults = {}

  await step(results, 'whatsapp', async () => {
    const { data } = await db
      .from('whatsapp_config')
      .select('waba_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!data?.waba_id || !data.access_token) return 'not connected'
    await unsubscribeWabaFromApp({ wabaId: data.waba_id as string, accessToken: decrypt(data.access_token as string) })
  })

  for (const table of ['messenger_config', 'instagram_config'] as const) {
    await step(results, table.replace('_config', ''), async () => {
      const { data } = await db.from(table).select('page_id, page_access_token').eq('account_id', accountId)
      const rows = (data ?? []) as { page_id: string | null; page_access_token: string | null }[]
      if (rows.length === 0) return 'not connected'
      for (const row of rows) {
        if (row.page_id && row.page_access_token) {
          await unsubscribePage({ pageId: row.page_id, token: decrypt(row.page_access_token) })
        }
      }
    })
  }

  await step(results, 'gmail', async () => {
    const { data } = await db.from('gmail_config').select('*').eq('account_id', accountId).maybeSingle()
    if (!data) return 'not connected'
    // switched off as the customer care inbox (migration 179): the watch was already stopped
    if (inboxIsOff(data)) return 'inbox off, no watch'
    await stopWatch({ accessToken: await gmailToken(data) })
  })

  await step(results, 'email', async () => {
    const { data } = await db.from('email_config').select('*').eq('account_id', accountId).maybeSingle()
    if (!data) return 'not connected'
    // switched off as the customer care inbox (migration 179): the subscription was already deleted
    if (!data.subscription_id) return inboxIsOff(data) ? 'inbox off, no subscription' : 'no subscription'
    await deleteSubscription({ accessToken: await ms365Token(data), subscriptionId: data.subscription_id })
  })

  await step(results, 'jira', async () => {
    const store = jiraStore(db)
    const connection = await store.getConnectionByAccount(accountId)
    if (!connection) return 'not connected'
    let client = null
    if (connection.status === 'active' && isJiraConfigured()) {
      try {
        client = clientForConnection(db, connection, { store })
      } catch {
        client = null
      }
    }
    const r = await disconnect({ db, store, client, connection, userId: null, purge: true })
    return r.webhooksRemoved ? 'ok' : 'disconnected; webhooks expire on their own'
  })

  return results
}
