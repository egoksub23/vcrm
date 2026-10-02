import crypto from 'node:crypto'

import { isTemplateWebhookField } from './template-webhook'

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * Meta signs the raw request body with your App Secret and sends the
 * result in the `x-hub-signature-256: sha256=<hex>` header. Without
 * verification, anyone who knows our webhook URL can POST fabricated
 * status updates and drift broadcast counts arbitrarily.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * Contract:
 *   `META_APP_SECRET` is **required**. If it's missing we fail closed —
 *   every request is rejected until the operator configures the
 *   secret. A previous version fell open with a warning log, which is
 *   unsafe for a public template: anyone who forgets the env var would
 *   be running a fully spoofable webhook.
 *
 *   It may hold **several** secrets separated by commas (issue #500).
 *   Each Meta App signs with its own secret, so one deployment that
 *   receives webhooks from WABAs living under different Meta Apps needs
 *   to accept any of them. A request is valid when its signature
 *   matches ANY configured secret; each candidate is compared in
 *   constant time. See docs/multi-waba.md.
 */

/**
 * Split `META_APP_SECRET` into its candidate secrets: comma-separated,
 * whitespace trimmed, empties dropped. Exported for tests and for
 * anything else that wants to know how many apps are configured.
 */
export function parseAppSecrets(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function signatureMatches(rawBody: string, signatureHeader: string, secret: string): boolean {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secrets = parseAppSecrets(process.env.META_APP_SECRET)
  if (secrets.length === 0) {
    console.error(
      '[webhook] META_APP_SECRET is not set — rejecting request. ' +
        'Configure the env var (Meta → App Settings → Basic → App Secret) ' +
        'to enable signature verification.',
    )
    return false
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  // Deliberately no early return inside the loop's compare: every
  // candidate is checked with timingSafeEqual, and the loop cost is
  // proportional to the number of configured apps (public knowledge
  // from the operator's point of view), not to the secret contents.
  let ok = false
  for (const secret of secrets) {
    if (signatureMatches(rawBody, signatureHeader, secret)) ok = true
  }
  return ok
}

// ------------------------------------------------------------------
// Workspace-bound verification (migration 136)
// ------------------------------------------------------------------

/** The phone numbers and WABAs a WhatsApp delivery claims to be about. */
export interface WhatsAppIds {
  phoneNumberIds: string[]
  wabaIds: string[]
}

/**
 * Read the ids out of an (UNTRUSTED, not yet verified) payload. Only used
 * to decide which stored secrets could legitimately have signed it; nothing
 * is acted on until a signature has matched.
 */
export function collectWhatsAppIds(body: unknown): WhatsAppIds {
  const phone = new Set<string>()
  const waba = new Set<string>()
  const entries = (body as { entry?: unknown } | null)?.entry
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const e = entry as { id?: unknown; changes?: unknown } | null
      if (!e || !Array.isArray(e.changes)) continue
      for (const change of e.changes) {
        const c = change as { field?: unknown; value?: { metadata?: { phone_number_id?: unknown } } } | null
        if (!c) continue
        // Message-template lifecycle fields carry the WABA id (entry.id), not a phone number.
        if (typeof c.field === 'string' && isTemplateWebhookField(c.field)) {
          if (typeof e.id === 'string' || typeof e.id === 'number') waba.add(String(e.id))
          continue
        }
        const pn = c.value?.metadata?.phone_number_id
        if (typeof pn === 'string' || typeof pn === 'number') phone.add(String(pn))
      }
    }
  }
  return { phoneNumberIds: [...phone], wabaIds: [...waba] }
}

/** A stored per-workspace secret row. */
export interface TenantSecretRow {
  phone_number_id: string | null
  waba_id: string | null
  app_secret_enc: string | null
}

/**
 * Verify a WhatsApp delivery.
 *
 *  1. Signed with an operator-owned secret (META_APP_SECRET): accepted for
 *     any number, exactly as before.
 *  2. Otherwise signed with a workspace's own app secret: accepted only if
 *     EVERY phone number and WABA the payload names belongs to a
 *     workspace whose registered secret produced the signature. A payload
 *     that mixes in a number the signer does not hold is rejected whole.
 *
 * `loadTenantSecrets` fetches the rows for the ids named (kept injectable
 * so this stays free of the database client); `decryptSecret` is the
 * shared decrypt. Any failure to read or decrypt rejects, never accepts.
 */
export async function verifyWhatsAppWebhook(
  rawBody: string,
  signatureHeader: string | null,
  loadTenantSecrets: (ids: WhatsAppIds) => Promise<TenantSecretRow[]>,
  decryptSecret: (ciphertext: string) => string,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false

  if (verifyMetaWebhookSignature(rawBody, signatureHeader)) return true

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return false
  }
  const ids = collectWhatsAppIds(body)
  if (ids.phoneNumberIds.length === 0 && ids.wabaIds.length === 0) return false

  let rows: TenantSecretRow[]
  try {
    rows = (await loadTenantSecrets(ids)).filter((r) => r.app_secret_enc)
  } catch {
    return false
  }
  if (rows.length === 0) return false

  // Which rows' secrets actually produced this signature?
  const signing: TenantSecretRow[] = []
  for (const row of rows) {
    let secret: string
    try {
      secret = decryptSecret(row.app_secret_enc as string)
    } catch {
      continue
    }
    if (secret && signatureMatches(rawBody, signatureHeader, secret)) signing.push(row)
  }
  if (signing.length === 0) return false

  const phoneOk = ids.phoneNumberIds.every((id) => signing.some((r) => r.phone_number_id === id))
  const wabaOk = ids.wabaIds.every((id) => signing.some((r) => r.waba_id === id))
  return phoneOk && wabaOk
}
