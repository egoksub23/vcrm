import { describe, expect, it } from 'vitest'

import { EncryptionConfigError, LEGACY_KEY_ID, parseKeyRing, primaryKeyMaterial } from './keyring'

const K0 = '0'.repeat(64)
const K1 = '1'.repeat(64)
const K2 = 'a'.repeat(64)

describe('parseKeyRing', () => {
  it('with only ENCRYPTION_KEY, writes under the original key in the original format', () => {
    const ring = parseKeyRing({ ENCRYPTION_KEY: K0 })
    expect(ring.current).toMatchObject({ id: LEGACY_KEY_ID, versioned: false })
    expect(ring.current.key.toString('hex')).toBe(K0)
    expect([...ring.keys.keys()]).toEqual([LEGACY_KEY_ID])
  })

  it('loads extra keys and writes under the one named by ENCRYPTION_KEY_ID', () => {
    const ring = parseKeyRing({ ENCRYPTION_KEY: K0, ENCRYPTION_KEYS: `2026a:${K1}, 2026b:${K2}`, ENCRYPTION_KEY_ID: '2026a' })
    expect([...ring.keys.keys()].sort()).toEqual([LEGACY_KEY_ID, '2026a', '2026b'].sort())
    expect(ring.current).toMatchObject({ id: '2026a', versioned: true })
    expect(ring.current.key.toString('hex')).toBe(K1)
  })

  it('works after the original key is retired, as long as a current id is named', () => {
    const ring = parseKeyRing({ ENCRYPTION_KEYS: `2026a:${K1}`, ENCRYPTION_KEY_ID: '2026a' })
    expect(ring.legacy).toBeNull()
    expect(ring.current.id).toBe('2026a')
  })

  it('may name the original key as current (rolling back a rotation)', () => {
    const ring = parseKeyRing({ ENCRYPTION_KEY: K0, ENCRYPTION_KEYS: `2026a:${K1}`, ENCRYPTION_KEY_ID: LEGACY_KEY_ID })
    expect(ring.current).toMatchObject({ id: LEGACY_KEY_ID, versioned: false })
  })

  it.each([
    [{}, /not configured/],
    [{ ENCRYPTION_KEY: 'short' }, /64 hexadecimal/],
    [{ ENCRYPTION_KEY: K0, ENCRYPTION_KEYS: 'nocolon' }, /id:hexkey/],
    [{ ENCRYPTION_KEY: K0, ENCRYPTION_KEYS: `bad id:${K1}` }, /must be 1-32/],
    [{ ENCRYPTION_KEY: K0, ENCRYPTION_KEYS: `v2.x:${K1}` }, /must be 1-32/],
    [{ ENCRYPTION_KEY: K0, ENCRYPTION_KEYS: `${LEGACY_KEY_ID}:${K1}` }, /reserved/],
    [{ ENCRYPTION_KEY: K0, ENCRYPTION_KEYS: `a:${K1},a:${K2}` }, /twice/],
    [{ ENCRYPTION_KEY: K0, ENCRYPTION_KEYS: 'a:nothex' }, /64 hexadecimal/],
    [{ ENCRYPTION_KEY: K0, ENCRYPTION_KEY_ID: 'missing' }, /not one of the configured/],
    [{ ENCRYPTION_KEYS: `a:${K1}` }, /ENCRYPTION_KEY_ID must be set/],
  ])('rejects a bad configuration %#', (env, message) => {
    expect(() => parseKeyRing(env)).toThrow(EncryptionConfigError)
    expect(() => parseKeyRing(env)).toThrow(message)
  })
})

describe('primaryKeyMaterial', () => {
  it('is the original key while it is configured, exactly as written', () => {
    expect(primaryKeyMaterial({ ENCRYPTION_KEY: 'abc', ENCRYPTION_KEYS: `x:${K1}`, ENCRYPTION_KEY_ID: 'x' })).toBe('abc')
  })
  it('falls back to the named current key, then the first listed, then null', () => {
    expect(primaryKeyMaterial({ ENCRYPTION_KEYS: `a:${K1},b:${K2}`, ENCRYPTION_KEY_ID: 'b' })).toBe(K2)
    expect(primaryKeyMaterial({ ENCRYPTION_KEYS: `a:${K1},b:${K2}` })).toBe(K1)
    expect(primaryKeyMaterial({})).toBeNull()
  })
})
