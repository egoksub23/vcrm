import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  row: null as unknown,
  error: false,
  filters: [] as [string, unknown][],
  config: null as null | { enabled: boolean; gateway_base_url: string },
  flagOn: true,
}))

vi.mock('./config', () => ({
  findConfigForAccount: async () => h.config,
  openConfig: () => ({ signingSecret: 's', apiToken: 'tok' }),
}))
vi.mock('./feature', () => ({ vircleChatEnabled: async () => h.flagOn }))

import { findVircleTarget, openGatewayConnection } from './connection'

const db = {
  from: () => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (h.filters.push([c, v]), b),
      maybeSingle: async () => ({ data: h.row, error: h.error ? { message: 'boom' } : null }),
    }
    return b
  },
}

beforeEach(() => {
  h.row = { id: 'cv-1', last_channel_type: 'vircle_chat', contact: { wallet_id: 'W123' } }
  h.error = false
  h.filters = []
  h.config = { enabled: true, gateway_base_url: 'https://gw.example.com' }
  h.flagOn = true
})

describe('findVircleTarget', () => {
  it('returns the wallet id for a Vircle Chat conversation in this workspace', async () => {
    expect(await findVircleTarget(db as never, 'acct-1', 'cv-1')).toEqual({ conversationId: 'cv-1', walletId: 'W123' })
    expect(h.filters).toEqual([['id', 'cv-1'], ['account_id', 'acct-1']])
  })

  it('reads the contact whether the join comes back as an object or a one-item list', async () => {
    h.row = { id: 'cv-1', last_channel_type: 'vircle_chat', contact: [{ wallet_id: 'W9' }] }
    expect(await findVircleTarget(db as never, 'acct-1', 'cv-1')).toMatchObject({ walletId: 'W9' })
  })

  it('refuses a conversation that is not found, is not a Vircle Chat one, or has no wallet id', async () => {
    h.row = null
    expect(await findVircleTarget(db as never, 'acct-1', 'cv-1')).toBeNull()
    h.row = { id: 'cv-1', last_channel_type: 'whatsapp', contact: { wallet_id: 'W123' } }
    expect(await findVircleTarget(db as never, 'acct-1', 'cv-1')).toBeNull()
    h.row = { id: 'cv-1', last_channel_type: 'vircle_chat', contact: { wallet_id: null } }
    expect(await findVircleTarget(db as never, 'acct-1', 'cv-1')).toBeNull()
    h.row = { id: 'cv-1', last_channel_type: 'vircle_chat', contact: { wallet_id: 'W123' } }
    h.error = true
    expect(await findVircleTarget(db as never, 'acct-1', 'cv-1')).toBeNull()
  })

  it('can skip the channel check when asked', async () => {
    h.row = { id: 'cv-1', last_channel_type: 'whatsapp', contact: { wallet_id: 'W123' } }
    expect(await findVircleTarget(db as never, 'acct-1', 'cv-1', { requireVircleChannel: false })).toMatchObject({ walletId: 'W123' })
  })
})

describe('openGatewayConnection', () => {
  it('opens the stored connection', async () => {
    expect(await openGatewayConnection(db as never, 'acct-1')).toEqual({ baseUrl: 'https://gw.example.com', apiToken: 'tok' })
  })

  it('returns null when there is no connection, it is paused, or the operator switched it off', async () => {
    h.config = null
    expect(await openGatewayConnection(db as never, 'acct-1')).toBeNull()
    h.config = { enabled: false, gateway_base_url: 'https://gw.example.com' }
    expect(await openGatewayConnection(db as never, 'acct-1')).toBeNull()
    h.config = { enabled: true, gateway_base_url: 'https://gw.example.com' }
    h.flagOn = false
    expect(await openGatewayConnection(db as never, 'acct-1')).toBeNull()
  })
})
