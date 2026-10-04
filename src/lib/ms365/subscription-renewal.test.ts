import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  createSubscription: vi.fn(async () => ({ id: 'sub-new', expirationDateTime: '2026-10-07T00:00:00Z' })),
  renewSubscription: vi.fn(async () => ({ id: 'sub-old', expirationDateTime: '2026-10-07T00:00:00Z' })),
  deleteSubscription: vi.fn(async () => undefined),
}))

vi.mock('@/lib/ms365/mail-api', () => h)
vi.mock('@/lib/ms365/token', () => ({ getValidAccessToken: async () => 'token' }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'client-state' }))

import { renewMailboxSubscription, subscriptionAddressChanged } from './subscription-renewal'

const NEW = 'https://halo.vircle.tech'
const NEW_URL = `${NEW}/api/email/webhook`

function db() {
  const updates: Record<string, unknown>[] = []
  const client = {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        updates.push(patch)
        return { eq: async () => ({ error: null }) }
      },
    }),
  } as unknown as SupabaseClient
  return { client, updates }
}

const config = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cfg-1',
    account_id: 'acct-1',
    access_token: 'x',
    access_token_expires_at: '2030-01-01T00:00:00Z',
    refresh_token: 'y',
    client_state: 'enc',
    subscription_id: 'sub-old',
    ...over,
  }) as never

beforeEach(() => {
  h.createSubscription.mockClear()
  h.renewSubscription.mockClear()
  h.deleteSubscription.mockClear()
})

describe('subscriptionAddressChanged', () => {
  it('is a change when the recorded address differs or was never recorded; not when it matches (slash aside) or the column is absent', () => {
    expect(subscriptionAddressChanged('https://crm.vircle.tech/api/email/webhook', NEW_URL)).toBe(true)
    expect(subscriptionAddressChanged(null, NEW_URL)).toBe(true)
    expect(subscriptionAddressChanged(NEW_URL, NEW_URL)).toBe(false)
    expect(subscriptionAddressChanged(`${NEW_URL}/`, NEW_URL)).toBe(false)
    expect(subscriptionAddressChanged(undefined, NEW_URL)).toBe(false)
  })
})

describe('renewMailboxSubscription', () => {
  it('renews in place when the address is unchanged, and keeps the recorded address', async () => {
    const d = db()
    const r = await renewMailboxSubscription({ admin: d.client, config: config({ subscription_notification_url: NEW_URL }), baseUrl: NEW })
    expect(r).toMatchObject({ subscriptionId: 'sub-old', recreated: false })
    expect(h.createSubscription).not.toHaveBeenCalled()
    expect(h.deleteSubscription).not.toHaveBeenCalled()
    expect(d.updates[0]).not.toHaveProperty('subscription_notification_url')
  })

  it('creates a new subscription at the new address, drops the old one and records the address', async () => {
    const d = db()
    const r = await renewMailboxSubscription({
      admin: d.client,
      config: config({ subscription_notification_url: 'https://crm.vircle.tech/api/email/webhook' }),
      baseUrl: NEW,
    })
    expect(r).toMatchObject({ subscriptionId: 'sub-new', recreated: true })
    expect(h.createSubscription).toHaveBeenCalledWith(expect.objectContaining({ notificationUrl: NEW_URL }))
    expect(h.deleteSubscription).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub-old' }))
    expect(h.renewSubscription).not.toHaveBeenCalled()
    expect(d.updates[0]).toMatchObject({ subscription_id: 'sub-new', subscription_notification_url: NEW_URL })
  })

  it('recreates once a subscription made before addresses were recorded, so it is tracked from then on', async () => {
    const d = db()
    await renewMailboxSubscription({ admin: d.client, config: config({ subscription_notification_url: null }), baseUrl: NEW })
    expect(h.createSubscription).toHaveBeenCalledTimes(1)
    expect(d.updates[0]).toMatchObject({ subscription_notification_url: NEW_URL })
  })

  it('renews as before when the address column does not exist yet', async () => {
    const d = db()
    await renewMailboxSubscription({ admin: d.client, config: config(), baseUrl: NEW })
    expect(h.renewSubscription).toHaveBeenCalledTimes(1)
    expect(h.createSubscription).not.toHaveBeenCalled()
  })

  it('creates one when there is none, and when Microsoft refuses the renewal', async () => {
    const d = db()
    await renewMailboxSubscription({ admin: d.client, config: config({ subscription_id: null, subscription_notification_url: null }), baseUrl: NEW })
    expect(h.createSubscription).toHaveBeenCalledTimes(1)

    h.renewSubscription.mockRejectedValueOnce(new Error('gone'))
    const d2 = db()
    const r = await renewMailboxSubscription({ admin: d2.client, config: config({ subscription_notification_url: NEW_URL }), baseUrl: NEW })
    expect(r.recreated).toBe(true)
    expect(d2.updates[0]).toMatchObject({ subscription_notification_url: NEW_URL })
  })
})
