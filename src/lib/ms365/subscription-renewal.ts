import type { SupabaseClient } from '@supabase/supabase-js'

import { getValidAccessToken, type EmailConfigRow } from '@/lib/ms365/token'
import { createSubscription, renewSubscription } from '@/lib/ms365/mail-api'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Renews (or, if it's already lapsed/missing, re-creates) one
 * mailbox's Graph change-notification subscription and persists the
 * new id/expiry. Shared by the cron sweep (subscription-renew) and
 * the client-triggered heartbeat (subscription-heartbeat) so both
 * paths agree on exactly what "renew" means.
 */
export async function renewMailboxSubscription(args: {
  admin: SupabaseClient
  config: EmailConfigRow & { subscription_id: string | null; client_state: string }
  baseUrl: string
}): Promise<{ subscriptionId: string; expiresAt: string }> {
  const { admin, config, baseUrl } = args
  const accessToken = await getValidAccessToken(config)
  const notificationUrl = `${baseUrl}/api/email/webhook`

  const subscription = config.subscription_id
    ? await renewSubscription({ accessToken, subscriptionId: config.subscription_id }).catch(() =>
        createSubscription({
          accessToken,
          notificationUrl,
          clientState: decrypt(config.client_state),
        }),
      )
    : await createSubscription({
        accessToken,
        notificationUrl,
        clientState: decrypt(config.client_state),
      })

  await admin
    .from('email_config')
    .update({
      subscription_id: subscription.id,
      subscription_expires_at: subscription.expirationDateTime,
    })
    .eq('id', config.id)

  return { subscriptionId: subscription.id, expiresAt: subscription.expirationDateTime }
}
