// ============================================================
// Web Widget v2 — the per-workspace identity secret at rest.
//
// Stored ENCRYPTED (AES-256-GCM via the same helper the Gmail / Jira /
// WhatsApp connections use) in `web_widget_config.identity_secret_enc`,
// with the last four characters kept in the clear for the settings screen
// ("wis_...abcd"). The plaintext exists exactly twice: in the response of
// the generate / rotate call (shown to the admin once) and in memory while
// a token is being verified.
// ============================================================
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { generateIdentitySecret } from '@/lib/widget/identity-token'

export interface NewIdentitySecret {
  /** Shown to the admin once, never stored in the clear. */
  secret: string
  enc: string
  last4: string
}

export function createIdentitySecret(): NewIdentitySecret {
  const secret = generateIdentitySecret()
  return { secret, enc: encrypt(secret), last4: secret.slice(-4) }
}

/** Decrypt the stored secret, or null when there is none / it cannot be read. */
export function decryptIdentitySecret(enc: string | null | undefined): string | null {
  if (!enc) return null
  try {
    return decrypt(enc)
  } catch (err) {
    console.error('[widget/identity-secret] could not decrypt the stored secret:', err instanceof Error ? err.message : err)
    return null
  }
}
