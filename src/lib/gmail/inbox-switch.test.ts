import { afterEach, describe, expect, it, vi } from 'vitest'

import { setGmailInbox, type GmailInboxDeps, type GmailInboxRow } from './inbox-switch'

// Switching a Gmail mailbox on or off as the customer care inbox. Off: the flag is written first, the push watch is stopped, its expiry cleared. On: the
// history baseline moves to NOW (nothing received while it was off is replayed), a new watch is registered when the deployment has a topic, then the flag is
// written. Google is faked.

afterEach(() => vi.restoreAllMocks())

function row(over: Partial<GmailInboxRow> = {}): GmailInboxRow {
  return {
    id: 'g-1',
    account_id: 'A',
    access_token: 'enc:at',
    access_token_expires_at: '2030-01-01T00:00:00Z',
    refresh_token: 'enc:rt',
    status: 'connected',
    needs_reauth: false,
    inbox_enabled: true,
    history_id: '100',
    watch_expiration: '2026-10-10T00:00:00Z',
    ...over,
  }
}

function world(config: GmailInboxRow | null, over: Partial<GmailInboxDeps> = {}) {
  const log: string[] = []
  const saved: Record<string, unknown>[] = []
  const deps: GmailInboxDeps = {
    loadConfig: async () => config,
    setFlag: async (_a, value) => {
      log.push(`flag:${value}`)
      return null
    },
    saveWatch: async (_id, patch) => {
      log.push('save')
      saved.push(patch)
      return null
    },
    getAccessToken: async () => 'token',
    stopWatch: async () => {
      log.push('stop')
      return true
    },
    watchMailbox: async ({ topicName }) => {
      log.push(`watch:${topicName}`)
      return { historyId: '900', expiration: '2026-10-15T00:00:00Z' }
    },
    getCurrentHistoryId: async () => {
      log.push('history')
      return '777'
    },
    pubsubTopic: () => 'projects/p/topics/t',
    ...over,
  }
  return { deps, log, saved }
}

describe('switching the Gmail inbox off', () => {
  it('writes the flag first, then stops the push watch, then clears its expiry and leaves the history baseline alone', async () => {
    const w = world(row())
    expect(await setGmailInbox({ accountId: 'A', enabled: false }, w.deps)).toEqual({ ok: true, inbox_enabled: false, watch: 'stopped' })
    expect(w.log).toEqual(['flag:false', 'stop', 'save'])
    expect(w.saved[0]).toEqual({ watch_expiration: null })
  })

  it('is still off when Google cannot be told: it says so, and clears the expiry anyway', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dead = world(row(), {
      getAccessToken: async () => {
        throw new Error('invalid_grant')
      },
    })
    expect(await setGmailInbox({ accountId: 'A', enabled: false }, dead.deps)).toEqual({ ok: true, inbox_enabled: false, watch: 'stop_failed' })
    expect(dead.saved).toEqual([{ watch_expiration: null }])
    const refused = world(row(), { stopWatch: async () => false })
    expect(await setGmailInbox({ accountId: 'A', enabled: false }, refused.deps)).toMatchObject({ watch: 'stop_failed' })
  })

  it('has nothing to stop when no watch was registered (no Pub/Sub topic), and still turns the flag off', async () => {
    const w = world(row({ watch_expiration: null }))
    expect(await setGmailInbox({ accountId: 'A', enabled: false }, w.deps)).toMatchObject({ ok: true, inbox_enabled: false, watch: 'unchanged' })
  })

  it('does not touch Google when the flag could not be written, and refuses when no mailbox is connected', async () => {
    const w = world(row(), { setFlag: async () => ({ message: 'rls' }) })
    expect(await setGmailInbox({ accountId: 'A', enabled: false }, w.deps)).toMatchObject({ ok: false, status: 500, code: 'save_failed' })
    expect(w.log).toEqual([])
    expect(await setGmailInbox({ accountId: 'A', enabled: false }, world(null).deps)).toMatchObject({ ok: false, status: 404, code: 'not_connected' })
  })
})

describe('switching the Gmail inbox on', () => {
  it('registers a new watch, moves the history baseline to now, then writes the flag', async () => {
    const w = world(row({ inbox_enabled: false, watch_expiration: null, history_id: '100' }))
    const r = await setGmailInbox({ accountId: 'A', enabled: true }, w.deps)
    expect(r).toEqual({ ok: true, inbox_enabled: true, watch: 'started' })
    expect(w.log).toEqual(['watch:projects/p/topics/t', 'save', 'flag:true'])
    // the baseline is the watch's own "now": mail that arrived while the inbox was off (history 100 to 900) is never replayed
    expect(w.saved[0]).toEqual({ watch_expiration: '2026-10-15T00:00:00Z', history_id: '900' })
  })

  it('without a Pub/Sub topic registers no watch but still moves the baseline to now', async () => {
    const w = world(row({ inbox_enabled: false, watch_expiration: null }), { pubsubTopic: () => null })
    const r = await setGmailInbox({ accountId: 'A', enabled: true }, w.deps)
    expect(r).toEqual({ ok: true, inbox_enabled: true, watch: 'not_configured' })
    expect(w.saved[0]).toEqual({ watch_expiration: null, history_id: '777' })
  })

  it('never claims an inbox that is not listening: when the watch cannot be started the flag stays off', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const w = world(row({ inbox_enabled: false }), {
      watchMailbox: async () => {
        throw new Error('Google said no')
      },
    })
    expect(await setGmailInbox({ accountId: 'A', enabled: true }, w.deps)).toMatchObject({ ok: false, status: 502, code: 'watch_failed' })
    expect(w.log).toEqual([])
  })

  it('asks for a reconnect first when the mailbox needs one', async () => {
    for (const over of [{ needs_reauth: true }, { status: 'error' }]) {
      const w = world(row({ inbox_enabled: false, ...over }))
      expect(await setGmailInbox({ accountId: 'A', enabled: true }, w.deps)).toMatchObject({ ok: false, status: 409, code: 'needs_reconnect' })
      expect(w.log).toEqual([])
    }
  })

  it('is a no-op when the inbox is already on: the history baseline must not move (mail since the last push would be skipped)', async () => {
    const w = world(row())
    expect(await setGmailInbox({ accountId: 'A', enabled: true }, w.deps)).toEqual({ ok: true, inbox_enabled: true, watch: 'unchanged' })
    expect(w.log).toEqual([])
  })

  it('stops the new watch again when the flag cannot be written after it', async () => {
    const w = world(row({ inbox_enabled: false }), { setFlag: async () => ({ message: 'rls' }) })
    expect(await setGmailInbox({ accountId: 'A', enabled: true }, w.deps)).toMatchObject({ ok: false, status: 500, code: 'save_failed' })
    expect(w.log).toEqual(['watch:projects/p/topics/t', 'save', 'stop', 'save'])
    expect(w.saved[1]).toEqual({ watch_expiration: null })
  })
})
