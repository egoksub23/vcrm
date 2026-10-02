import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { decrypt, encrypt, isLegacyFormat, keyIdOf, needsReencrypt } from './encryption'

const ORIGINAL = process.env.ENCRYPTION_KEY!
const K1 = '1'.repeat(64)
const K2 = 'b'.repeat(64)
const saved = { ...process.env }

function setEnv(env: Record<string, string | undefined>) {
  for (const k of ['ENCRYPTION_KEY', 'ENCRYPTION_KEYS', 'ENCRYPTION_KEY_ID']) delete process.env[k]
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v
}

beforeEach(() => setEnv({ ENCRYPTION_KEY: ORIGINAL }))
afterEach(() => {
  setEnv({
    ENCRYPTION_KEY: saved.ENCRYPTION_KEY,
    ENCRYPTION_KEYS: saved.ENCRYPTION_KEYS,
    ENCRYPTION_KEY_ID: saved.ENCRYPTION_KEY_ID,
  })
})

describe('key rotation', () => {
  it('without ENCRYPTION_KEY_ID writes the unversioned format an older build can read', () => {
    const ct = encrypt('secret')
    expect(ct.split(':')).toHaveLength(3)
    expect(keyIdOf(ct)).toBe('legacy')
    expect(needsReencrypt(ct)).toBe(false)
  })

  it('with ENCRYPTION_KEY_ID writes v2:<id>:... and reads it back', () => {
    setEnv({ ENCRYPTION_KEY: ORIGINAL, ENCRYPTION_KEYS: `2026a:${K1}`, ENCRYPTION_KEY_ID: '2026a' })
    const ct = encrypt('secret')
    expect(ct.startsWith('v2:2026a:')).toBe(true)
    expect(ct.split(':')).toHaveLength(5)
    expect(keyIdOf(ct)).toBe('2026a')
    expect(decrypt(ct)).toBe('secret')
    expect(needsReencrypt(ct)).toBe(false)
  })

  it('old values stay readable after rotating, and are reported as needing re-encryption', () => {
    const before = encrypt('old secret')
    setEnv({ ENCRYPTION_KEY: ORIGINAL, ENCRYPTION_KEYS: `2026a:${K1}`, ENCRYPTION_KEY_ID: '2026a' })
    expect(decrypt(before)).toBe('old secret')
    expect(needsReencrypt(before)).toBe(true)
    const after = encrypt(decrypt(before))
    expect(keyIdOf(after)).toBe('2026a')
    expect(needsReencrypt(after)).toBe(false)
  })

  it('a value under an older named key still reads, and is stale once a newer key is current', () => {
    setEnv({ ENCRYPTION_KEY: ORIGINAL, ENCRYPTION_KEYS: `a:${K1},b:${K2}`, ENCRYPTION_KEY_ID: 'a' })
    const underA = encrypt('x')
    setEnv({ ENCRYPTION_KEY: ORIGINAL, ENCRYPTION_KEYS: `a:${K1},b:${K2}`, ENCRYPTION_KEY_ID: 'b' })
    expect(decrypt(underA)).toBe('x')
    expect(needsReencrypt(underA)).toBe(true)
  })

  it('fails clearly when a value names a key that is not configured (a retired key)', () => {
    setEnv({ ENCRYPTION_KEY: ORIGINAL, ENCRYPTION_KEYS: `a:${K1}`, ENCRYPTION_KEY_ID: 'a' })
    const underA = encrypt('x')
    setEnv({ ENCRYPTION_KEY: ORIGINAL })
    expect(() => decrypt(underA)).toThrow(/not configured/)
  })

  it('rejects a tampered versioned value', () => {
    setEnv({ ENCRYPTION_KEY: ORIGINAL, ENCRYPTION_KEYS: `a:${K1}`, ENCRYPTION_KEY_ID: 'a' })
    const [v, id, iv, ct, tag] = encrypt('secret').split(':')
    const flipped = (parseInt(ct.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, '0') + ct.slice(2)
    expect(() => decrypt([v, id, iv, flipped, tag].join(':'))).toThrow()
  })

  it('reads unversioned values written under a key that has since moved into ENCRYPTION_KEYS', () => {
    // the original key was replaced; the old one is kept in the ring as a fallback
    const before = encrypt('legacy')
    setEnv({ ENCRYPTION_KEY: K2, ENCRYPTION_KEYS: `previous:${ORIGINAL}` })
    expect(decrypt(before)).toBe('legacy')
  })

  it('CBC values are always stale, and only try the original key', () => {
    const iv = crypto.randomBytes(16)
    const c = crypto.createCipheriv('aes-256-cbc', Buffer.from(ORIGINAL, 'hex'), iv)
    const cbc = `${iv.toString('hex')}:${c.update('cbc secret', 'utf8', 'hex') + c.final('hex')}`
    expect(isLegacyFormat(cbc)).toBe(true)
    expect(keyIdOf(cbc)).toBe('legacy-cbc')
    expect(needsReencrypt(cbc)).toBe(true)
    expect(decrypt(cbc)).toBe('cbc secret')
  })

  it('leaves values that are not encrypted at all alone', () => {
    expect(keyIdOf('plain-verify-token')).toBeNull()
    expect(keyIdOf('')).toBeNull()
    expect(needsReencrypt('plain-verify-token')).toBe(false)
  })
})
