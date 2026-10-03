// ============================================================
// Small crypto helpers: random ids and tokens, hashing of bearer tokens, and
// encryption at rest for the one secret the gateway must keep in readable form
// (Halo's webhook signing secret).
// ============================================================

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex')

/** `prefix` + random characters (base64url). */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`
}

/** Short random id: prefix + 20 hex characters. */
export function newId(prefix: string): string {
  return `${prefix}${randomBytes(10).toString('hex')}`
}

function keyFrom(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('GATEWAY_ENCRYPTION_KEY must be 64 hex characters (32 bytes)')
  return Buffer.from(hex, 'hex')
}

/** AES-256-GCM. Output `v1:<iv>:<ciphertext>:<tag>`, each base64url. */
export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFrom(keyHex), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join(':')
}

export function decryptSecret(sealed: string, keyHex: string): string {
  const [version, iv, ct, tag] = sealed.split(':')
  if (version !== 'v1' || !iv || !ct || !tag) throw new Error('Unrecognised secret format')
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(keyHex), Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
}
