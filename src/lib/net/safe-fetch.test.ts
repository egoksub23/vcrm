import { describe, expect, it, vi } from 'vitest'

// The real connection path is exercised below with a resolver that answers
// like a rebinding attacker's DNS: public for the check, private for the socket.
const dns = vi.hoisted(() => ({ answers: new Map<string, { address: string; family: number }[]>() }))
vi.mock('node:dns', async (orig) => {
  const actual = await orig<typeof import('node:dns')>()
  return {
    ...actual,
    lookup: (
      host: string,
      options: { all?: boolean },
      cb: (err: Error | null, addr?: unknown, family?: number) => void,
    ) => {
      const answers = dns.answers.get(host)
      if (!answers) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
      if (options.all) return cb(null, answers)
      cb(null, answers[0].address, answers[0].family)
    },
  }
})

import { BlockedAddressError, makeGuardedLookup, pinnedFetch } from './safe-fetch'

type Answer = { address: string; family: number }
const resolver = (answers: Answer[] | Error) =>
  ((_host: string, _opts: unknown, cb: (e: Error | null, a: Answer[]) => void) =>
    answers instanceof Error ? cb(answers, []) : cb(null, answers)) as never

function run(answers: Answer[] | Error, options: { all?: boolean } = {}) {
  return new Promise<{ err: Error | null; address?: unknown; family?: number }>((done) => {
    makeGuardedLookup(resolver(answers))('example.test', options, (err, address, family) =>
      done({ err, address, family }),
    )
  })
}

describe('makeGuardedLookup', () => {
  it('hands a public answer to the socket', async () => {
    const r = await run([{ address: '93.184.216.34', family: 4 }])
    expect(r.err).toBeNull()
    expect(r.address).toBe('93.184.216.34')
    expect(r.family).toBe(4)
  })

  it('returns the whole list when the socket asks for all of them', async () => {
    const list = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]
    const r = await run(list, { all: true })
    expect(r.address).toEqual(list)
  })

  it.each(['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.9', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])(
    'refuses %s',
    async (address) => {
      const r = await run([{ address, family: address.includes(':') ? 6 : 4 }])
      expect(r.err).toBeInstanceOf(BlockedAddressError)
    },
  )

  it('refuses when ANY answer is private, not just the first', async () => {
    const r = await run([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ])
    expect(r.err).toBeInstanceOf(BlockedAddressError)
  })

  it('passes a resolver failure and an empty answer on as errors', async () => {
    expect((await run(new Error('boom'))).err?.message).toBe('boom')
    expect((await run([])).err).toBeTruthy()
  })
})

describe('pinnedFetch', () => {
  it.each([
    'http://127.0.0.1/x',
    'http://10.1.2.3/x',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/x',
    'http://localhost:3000/x',
    'http://db.internal/x',
    'http://printer.local/x',
  ])('refuses %s before connecting', async (url) => {
    await expect(pinnedFetch(url)).rejects.toBeInstanceOf(BlockedAddressError)
  })

  it('refuses a name that resolves to a private address at connect time (DNS rebinding)', async () => {
    dns.answers.set('rebind.example', [{ address: '127.0.0.1', family: 4 }])
    const err = (await pinnedFetch('http://rebind.example/').catch((e) => e)) as Error & { cause?: unknown }
    expect(err).toBeInstanceOf(Error)
    expect(err.cause).toBeInstanceOf(BlockedAddressError)
  })

  it('refuses when only one of several answers is private', async () => {
    dns.answers.set('mixed.example', [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ])
    const err = (await pinnedFetch('http://mixed.example/').catch((e) => e)) as Error & { cause?: unknown }
    expect(err.cause).toBeInstanceOf(BlockedAddressError)
  })
})
