import crypto from 'crypto'

import { getKeyRing, LEGACY_KEY_ID } from '@/lib/crypto/keyring'

/**
 * Secret encryption (stored access tokens, API keys, webhook secrets).
 *
 * Formats:
 *   `v2:<keyId>:<iv-hex>:<ciphertext-hex>:<authTag-hex>`   GCM, names its key
 *   `<iv-hex>:<ciphertext-hex>:<authTag-hex>`              GCM, original key
 *   `<iv-hex>:<ciphertext-hex>`                            CBC (legacy, decrypt-only)
 *
 * Key rotation (see lib/crypto/keyring.ts and docs/encryption-key-rotation.md):
 * with only ENCRYPTION_KEY set, nothing changes and every write is the second
 * format, readable by older builds. Setting ENCRYPTION_KEY_ID switches new
 * writes to the first format under that key; every key in the ring stays
 * readable, so rotating never strands a stored secret.
 *
 * Why GCM instead of CBC:
 *   CBC without a MAC is unauthenticated — an attacker who can write
 *   rows to `whatsapp_config` (directly, through a future RLS bug, or
 *   via a DB backup being modified) can flip bits in the ciphertext
 *   without the decrypt throwing. You'd silently get garbled tokens;
 *   worst case, if the mutated bytes happen to form a valid access
 *   token, messages go out under a spoofed account. GCM appends a
 *   16-byte authentication tag; any tampering fails the decrypt hard.
 *
 * `decrypt()` auto-detects the format by counting parts. Existing rows can be
 * upgraded in place by call sites that hold a Supabase client — see the
 * `isLegacyFormat` / `encrypt` pattern in `src/app/api/whatsapp/send/route.ts`
 * — or all at once by the Platform console's re-encrypt action.
 */

// 12 bytes is the NIST-recommended IV length for GCM — keeps the
// counter block well below 2^32 and matches the default web-crypto
// behaviour, so any future port is straightforward.
const GCM_IV_LENGTH = 12
const CBC_IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const VERSION_TAG = 'v2'

export function encrypt(text: string): string {
  const { current } = getKeyRing()
  const iv = crypto.randomBytes(GCM_IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', current.key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag()
  const body = `${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`
  return current.versioned ? `${VERSION_TAG}:${current.id}:${body}` : body
}

function decryptGcm(ivHex: string, ctHex: string, tagHex: string, key: Buffer): string {
  const iv = Buffer.from(ivHex, 'hex')
  if (iv.length !== GCM_IV_LENGTH) {
    throw new Error(`Encrypted token has unexpected GCM IV length ${iv.length}`)
  }
  const authTag = Buffer.from(tagHex, 'hex')
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(`Encrypted token has unexpected GCM auth-tag length ${authTag.length}`)
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  let decrypted = decipher.update(ctHex, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

export function decrypt(encryptedText: string): string {
  const ring = getKeyRing()
  const parts = encryptedText.split(':')

  if (parts.length === 5 && parts[0] === VERSION_TAG) {
    // GCM naming its key.
    const [, keyId, ivHex, ctHex, tagHex] = parts
    const key = ring.keys.get(keyId)
    if (!key) {
      throw new Error(`Encrypted token was written with key '${keyId}', which is not configured`)
    }
    return decryptGcm(ivHex, ctHex, tagHex, key)
  }

  if (parts.length === 3) {
    // GCM, written before key ids existed: the original key first, then any
    // other key in the ring (the original may have been replaced mid-rotation).
    const [ivHex, ctHex, tagHex] = parts
    const candidates = [ring.legacy, ...[...ring.keys.values()].filter((k) => k !== ring.legacy)].filter(
      (k): k is Buffer => k !== null,
    )
    let lastError: unknown = new Error('No encryption key is configured')
    for (const key of candidates) {
      try {
        return decryptGcm(ivHex, ctHex, tagHex, key)
      } catch (err) {
        lastError = err
      }
    }
    throw lastError
  }

  if (parts.length === 2) {
    // CBC — legacy. Read-only; `encrypt()` never produces this shape.
    // No authentication tag, so only the original key is tried: a wrong key
    // can occasionally decrypt to garbage instead of failing.
    if (!ring.legacy) throw new Error('Legacy CBC token needs ENCRYPTION_KEY, which is not configured')
    const [ivHex, ctHex] = parts
    const iv = Buffer.from(ivHex, 'hex')
    if (iv.length !== CBC_IV_LENGTH) {
      throw new Error(`Encrypted token has unexpected CBC IV length ${iv.length}`)
    }
    const decipher = crypto.createDecipheriv('aes-256-cbc', ring.legacy, iv)
    let decrypted = decipher.update(ctHex, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }

  throw new Error(
    `Encrypted token has unrecognised format (expected 1, 2 or 4 colons, got ${parts.length - 1})`,
  )
}

/**
 * Cheap format detector — call sites use this to decide whether to
 * write a refreshed GCM ciphertext back to the database after a
 * successful legacy decrypt. Does not attempt decryption; purely a
 * structural check.
 */
export function isLegacyFormat(encryptedText: string): boolean {
  return encryptedText.split(':').length === 2
}

/**
 * Which key a stored value was written with: a ring id, `legacy` for the
 * original key (unversioned GCM) or `legacy-cbc`. `null` when the value is not
 * in a recognised encrypted shape (empty, plaintext, anything else).
 */
export function keyIdOf(value: string): string | null {
  const parts = value.split(':')
  if (parts.length === 5 && parts[0] === VERSION_TAG) return parts[1]
  if (parts.length === 3) return LEGACY_KEY_ID
  if (parts.length === 2) return 'legacy-cbc'
  return null
}

/**
 * True when re-encrypting `value` now would change how it is stored: it is CBC,
 * or the process is writing under a named key and the value is under another.
 * Unrecognised values are never "stale" — they are not ours to rewrite.
 */
export function needsReencrypt(value: string): boolean {
  const id = keyIdOf(value)
  if (id === null) return false
  if (id === 'legacy-cbc') return true
  const { current } = getKeyRing()
  return id !== current.id
}
