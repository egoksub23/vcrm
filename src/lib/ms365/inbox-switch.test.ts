import { afterEach, describe, expect, it, vi } from 'vitest'

import { setMs365Inbox, type InboxRow, type InboxSwitchDeps } from './inbox-switch'

// Switching a Microsoft 365 mailbox on or off as the customer care inbox. Off: the flag is written first, the Graph subscription is deleted, its columns are
// cleared. On: a new subscription is created with the existing renewal code, and only then is the flag written. Graph is faked.

afterEach(() => vi.restoreAllMocks())

const BASE_URL = 'https://halo.test'

function row(over: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 'cfg-1',
    account_id: 'A',
    access_token: 'enc:at',
    access_token_expires_at: '2030-01-01T00:00:00Z',
    refresh_token: 'enc:rt',
    client_state: 'enc:state',
    subscription_id: 'sub-1',
    subscription_notification_url: 'https://halo.test/api/email/webhook',
    status: 'connected',
    needs_reauth: false,
    inbox_enabled: true,
    ...over,
  }
}

function world(config: InboxRow | null, over: Partial<InboxSwitchDeps> = {}) {
  const log: string[] = []
  const saved: Record<string, unknown>[] = []
  const deps: InboxSwitchDeps = {
    loadConfig: async () => config,
    setFlag: async (_account, value) => {
      log.push(`flag:${value}`)
      return null
    },
    saveSubscription: async (_id, patch) => {
      log.push('save')
      saved.push(patch)
      return null
    },
    getAccessToken: async () => 'token',
    deleteSubscription: async ({ subscriptionId }) => {
      log.push(`delete:${subscriptionId}`)
      return true
    },
    startSubscription: async (c, baseUrl) => {
      log.push(`start:${c.subscription_id}:${baseUrl}`)
    },
    ...over,
  }
  return { deps, log, saved }
}

describe('switching the email inbox off', () => {
  it('writes the flag first, then deletes the Graph subscription, then clears the subscription columns', async () => {
    const w = world(row())
    const r = await setMs365Inbox({ accountId: 'A', enabled: false, baseUrl: BASE_URL }, w.deps)
    expect(r).toEqual({ ok: true, inbox_enabled: false, subscription: 'stopped' })
    expect(w.log).toEqual(['flag:false', 'delete:sub-1', 'save'])
    expect(w.saved[0]).toEqual({ subscription_id: null, subscription_expires_at: null, subscription_notification_url: null })
  })

  it('is still off when Graph cannot be told (the token is dead): it says so, and the subscription lapses by itself', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dead = world(row(), {
      getAccessToken: async () => {
        throw new Error('invalid_grant')
      },
    })
    expect(await setMs365Inbox({ accountId: 'A', enabled: false, baseUrl: BASE_URL }, dead.deps)).toEqual({ ok: true, inbox_enabled: false, subscription: 'stop_failed' })
    expect(dead.log).toEqual(['flag:false', 'save'])

    const refused = world(row(), { deleteSubscription: async () => false })
    expect(await setMs365Inbox({ accountId: 'A', enabled: false, baseUrl: BASE_URL }, refused.deps)).toMatchObject({ ok: true, subscription: 'stop_failed' })
    // the columns are cleared either way: the renewal job and the heartbeat have nothing to do for this mailbox
    expect(refused.saved).toHaveLength(1)
  })

  it('has nothing to delete when there was no subscription, and still turns the flag off', async () => {
    const w = world(row({ subscription_id: null }))
    expect(await setMs365Inbox({ accountId: 'A', enabled: false, baseUrl: BASE_URL }, w.deps)).toEqual({ ok: true, inbox_enabled: false, subscription: 'unchanged' })
    expect(w.log).toEqual(['flag:false', 'save'])
  })

  it('works for a mailbox that needs reconnecting or is paused: the switch does not depend on either', async () => {
    for (const over of [{ needs_reauth: true }, { enabled: false }]) {
      const w = world(row(over as Partial<InboxRow>))
      expect(await setMs365Inbox({ accountId: 'A', enabled: false, baseUrl: BASE_URL }, w.deps)).toMatchObject({ ok: true, inbox_enabled: false })
    }
  })

  it('falls back to clearing only the columns that exist before migration 156 (no notification-address column)', async () => {
    let first = true
    const w = world(row(), {
      saveSubscription: async (_id, patch) => {
        if (first) {
          first = false
          return { message: 'column "subscription_notification_url" does not exist' }
        }
        expect(patch).toEqual({ subscription_id: null, subscription_expires_at: null })
        return null
      },
    })
    expect(await setMs365Inbox({ accountId: 'A', enabled: false, baseUrl: BASE_URL }, w.deps)).toMatchObject({ ok: true })
  })

  it('does not touch Graph when the flag could not be written', async () => {
    const w = world(row(), { setFlag: async () => ({ message: 'rls' }) })
    expect(await setMs365Inbox({ accountId: 'A', enabled: false, baseUrl: BASE_URL }, w.deps)).toMatchObject({ ok: false, status: 500, code: 'save_failed' })
    expect(w.log).toEqual([])
  })

  it('refuses when no mailbox is connected', async () => {
    const w = world(null)
    expect(await setMs365Inbox({ accountId: 'A', enabled: false, baseUrl: BASE_URL }, w.deps)).toMatchObject({ ok: false, status: 404, code: 'not_connected' })
  })
})

describe('switching the email inbox on', () => {
  it('creates a new subscription with the existing renewal code (no id to renew), then writes the flag', async () => {
    const w = world(row({ inbox_enabled: false, subscription_id: null, subscription_notification_url: null }))
    const r = await setMs365Inbox({ accountId: 'A', enabled: true, baseUrl: BASE_URL }, w.deps)
    expect(r).toEqual({ ok: true, inbox_enabled: true, subscription: 'started' })
    expect(w.log).toEqual([`start:null:${BASE_URL}`, 'flag:true'])
  })

  it('never claims an inbox that is not listening: when the subscription cannot be created the flag stays off', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const w = world(row({ inbox_enabled: false, subscription_id: null }), {
      startSubscription: async () => {
        throw new Error('Graph said no')
      },
    })
    const r = await setMs365Inbox({ accountId: 'A', enabled: true, baseUrl: BASE_URL }, w.deps)
    expect(r).toMatchObject({ ok: false, status: 502, code: 'subscription_failed' })
    expect(w.log).toEqual([])
  })

  it('asks for a reconnect first when the mailbox needs one, and creates nothing', async () => {
    for (const over of [{ needs_reauth: true }, { status: 'error' }, { status: 'disconnected' }]) {
      const w = world(row({ inbox_enabled: false, subscription_id: null, ...over }))
      expect(await setMs365Inbox({ accountId: 'A', enabled: true, baseUrl: BASE_URL }, w.deps)).toMatchObject({ ok: false, status: 409, code: 'needs_reconnect' })
      expect(w.log).toEqual([])
    }
  })

  it('is a no-op when the inbox is already on and listening', async () => {
    const w = world(row())
    expect(await setMs365Inbox({ accountId: 'A', enabled: true, baseUrl: BASE_URL }, w.deps)).toEqual({ ok: true, inbox_enabled: true, subscription: 'unchanged' })
    expect(w.log).toEqual([])
  })

  it('starts the subscription when the flag says on but the subscription is gone (a lapsed one)', async () => {
    const w = world(row({ inbox_enabled: true, subscription_id: null }))
    expect(await setMs365Inbox({ accountId: 'A', enabled: true, baseUrl: BASE_URL }, w.deps)).toMatchObject({ ok: true, subscription: 'started' })
  })

  it('works for a paused mailbox: the pause is its own switch', async () => {
    const w = world(row({ inbox_enabled: false, subscription_id: null, enabled: false }))
    expect(await setMs365Inbox({ accountId: 'A', enabled: true, baseUrl: BASE_URL }, w.deps)).toMatchObject({ ok: true, subscription: 'started' })
  })

  it('takes the new subscription back down when the flag cannot be written after it', async () => {
    const config = row({ inbox_enabled: false, subscription_id: null })
    let current: InboxRow = config
    const w = world(config, {
      loadConfig: async () => current,
      startSubscription: async () => {
        current = { ...config, subscription_id: 'sub-new' }
      },
      setFlag: async () => ({ message: 'rls' }),
    })
    const r = await setMs365Inbox({ accountId: 'A', enabled: true, baseUrl: BASE_URL }, w.deps)
    expect(r).toMatchObject({ ok: false, status: 500, code: 'save_failed' })
    expect(w.log).toEqual(['delete:sub-new', 'save'])
  })
})
