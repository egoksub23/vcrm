import { beforeEach, describe, expect, it, vi } from 'vitest'

import { encrypt } from '@/lib/whatsapp/encryption'
import { signIdentityToken } from '@/lib/widget/identity-token'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import type { IdentityStore } from '@/lib/widget/identity-resolve'

const SECRET = 'wis_route_test_secret'

interface FakeDb {
  config: Record<string, unknown> | null
  visitor: Record<string, unknown> | null
  contact: Record<string, unknown> | null
}
let db: FakeDb
const writes: { table: string; op: string; row: unknown }[] = []
const rpcCalls: { fn: string; args: unknown }[] = []
const tagged: string[] = []

function chain(table: string) {
  const self: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order', 'limit', 'is', 'in']) self[m] = () => self
  for (const op of ['insert', 'update', 'upsert']) {
    self[op] = (row: unknown) => {
      writes.push({ table, op, row })
      return self
    }
  }
  const result = () => {
    if (table === 'web_widget_config') return { data: db.config, error: null }
    if (table === 'widget_visitors') return { data: db.visitor, error: null }
    if (table === 'contacts') return { data: db.contact, error: null }
    return { data: null, error: null }
  }
  self.maybeSingle = async () => result()
  self.single = async () => ({ data: { id: 'new-contact' }, error: null })
  self.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
  return self
}

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => chain(table),
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args })
      return { data: null, error: null }
    },
  }),
}))

vi.mock('@/lib/widget/visitor-auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/widget/visitor-auth')>('@/lib/widget/visitor-auth')
  return { ...actual, verifyVisitorJwt: vi.fn(async () => 'visitor-1') }
})

vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: vi.fn(async () => 'owner-1'),
  ContactError: class ContactError extends Error {
    status = 500
  },
}))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn(async () => undefined) }))
vi.mock('@/lib/widget/session-identity', () => ({ findOrCreatePrimaryConversation: vi.fn(async () => 'conv-1') }))
const sentCodeEmails: { to: string; code: string; widgetName: string }[] = []
vi.mock('@/lib/email/widget-verification-email', () => ({
  sendVerificationCodeEmail: vi.fn(async (args: { to: string; code: string; widgetName: string }) => {
    sentCodeEmails.push(args)
  }),
}))
vi.mock('@/lib/widget/tags', async () => {
  const actual = await vi.importActual<typeof import('@/lib/widget/tags')>('@/lib/widget/tags')
  return { ...actual, applyContactTagByName: vi.fn(async (_db: unknown, a: { name: string }) => void tagged.push(a.name)) }
})

let storeSeed: { byPhone?: unknown; byEmail?: unknown; mergeOk?: boolean } = {}
const merges: [string, string][] = []
const suggestions: [string, string][] = []
vi.mock('@/lib/widget/identity-resolve', async () => {
  const actual = await vi.importActual<typeof import('@/lib/widget/identity-resolve')>('@/lib/widget/identity-resolve')
  const store: IdentityStore = {
    findByPhone: async () => (storeSeed.byPhone as never) ?? null,
    findByEmail: async () => (storeSeed.byEmail as never) ?? null,
    findByWallet: async () => null,
    createContact: async () => ({ id: 'created-contact', created: true }),
    backfill: async () => undefined,
    mergeContacts: async (_a, p, s) => {
      merges.push([p, s])
      return storeSeed.mergeOk !== false
    },
    recordSuggestion: async (_a, x, y) => void suggestions.push([x, y]),
  }
  return { ...actual, createSupabaseIdentityStore: () => store }
})

import { POST } from './route'

const baseConfig = () => ({
  id: 'cfg-1',
  account_id: 'acc-1',
  enabled: true,
  allowed_origins: [],
  name: 'Support',
  welcome_message: 'Hi',
  primary_color: '#000000',
  avatar_url: null,
  position: 'right',
  verification_mode: 'none',
  identity_secret_enc: encrypt(SECRET),
})

let ipCounter = 0
function call(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return POST(
    new Request('https://crm.example/api/widget/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://site.example',
        Authorization: 'Bearer jwt',
        'x-forwarded-for': `10.0.0.${++ipCounter}`,
        ...headers,
      },
      body: JSON.stringify({ widgetToken: 'wt_1', ...body }),
    }),
  )
}

const visitorRow = (over: Record<string, unknown> = {}) => ({
  contact_id: 'contact-guest',
  identity_level: 'guest',
  identity_source: null,
  identity_verified_at: null,
  ...over,
})

beforeEach(() => {
  __resetRateLimitForTests()
  db = { config: baseConfig(), visitor: null, contact: null }
  writes.length = 0
  rpcCalls.length = 0
  tagged.length = 0
  merges.length = 0
  suggestions.length = 0
  sentCodeEmails.length = 0
  storeSeed = {}
})

const visitorUpsert = () => writes.find((w) => w.table === 'widget_visitors' && w.op === 'upsert')?.row as Record<string, unknown>

describe('POST /api/widget/session', () => {
  it('a brand-new browser with nothing offered gets needsIdentity (and the legacy alias)', async () => {
    const res = await call({})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      needsIdentity: true,
      needsPhone: true,
      branding: { name: 'Support', primaryColor: '#000000' },
      verification: { mode: 'none' },
      limits: { maxFileBytes: 16 * 1024 * 1024, maxVoiceSeconds: 300 },
    })
    expect(body.limits.allowedMimeTypes).toContain('image/jpeg')
    expect(body.conversationId).toBeUndefined()
    expect(writes.filter((w) => w.table === 'widget_visitors')).toHaveLength(0)
  })

  it('skipIdentity starts a guest', async () => {
    const res = await call({ skipIdentity: true })
    const body = await res.json()
    expect(body).toMatchObject({ needsIdentity: false, conversationId: 'conv-1', isGuest: true, identity: { level: 'guest' } })
    expect(visitorUpsert()).toMatchObject({ identity_level: 'guest', contact_id: 'new-contact' })
  })

  it('a valid signed token makes the visitor VERIFIED (source signed_app)', async () => {
    const identityToken = signIdentityToken(SECRET, { phone: '60123980112', name: 'Jane' })
    db.contact = { name: 'Jane', phone: '60123980112', email: null }
    const res = await call({ identityToken })
    const body = await res.json()
    expect(body.identity).toMatchObject({ level: 'verified', hasPhone: true, displayName: 'Jane' })
    expect(body.isGuest).toBe(false)
    expect(body.identityError).toBeUndefined()
    expect(visitorUpsert()).toMatchObject({ identity_level: 'verified', identity_source: 'signed_app' })
    expect(visitorUpsert().identity_verified_at).toBeTruthy()
  })

  it('a token signed with the wrong secret is rejected: identityError, visitor stays unidentified', async () => {
    const identityToken = signIdentityToken('wis_someone_elses_secret', { phone: '60123980112' })
    const res = await call({ identityToken })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ needsIdentity: true, identityError: 'bad_identity_token' })
    expect(visitorUpsert()).toBeUndefined()
  })

  it('an expired token reports expired_identity_token', async () => {
    const identityToken = signIdentityToken(SECRET, { phone: '60123980112' }, Math.floor(Date.now() / 1000) - 3600)
    const body = await (await call({ identityToken })).json()
    expect(body).toMatchObject({ needsIdentity: true, identityError: 'expired_identity_token' })
  })

  it('a token when no secret has been generated is a bad token', async () => {
    db.config = { ...baseConfig(), identity_secret_enc: null }
    const body = await (await call({ identityToken: signIdentityToken(SECRET, { phone: '60123980112' }) })).json()
    expect(body.identityError).toBe('bad_identity_token')
  })

  it('a bad token plus a typed claim still processes the claim', async () => {
    const body = await (
      await call({ identityToken: 'garbage.token', claim: { phone: '60123980112' } })
    ).json()
    expect(body).toMatchObject({ needsIdentity: false, identityError: 'bad_identity_token', identity: { level: 'claimed' } })
  })

  it('a typed claim that matches nobody creates a contact, tags "Claims existing user", claimFound=false', async () => {
    const body = await (await call({ claim: { phone: '60123980112', name: 'Sam' } })).json()
    expect(body).toMatchObject({ identity: { level: 'claimed', displayName: 'Sam' }, claimFound: false })
    expect(tagged).toEqual(['Claims existing user'])
    expect(visitorUpsert()).toMatchObject({ identity_level: 'claimed', identity_source: 'typed' })
  })

  it('a typed claim that matches an existing contact is claimFound=true, no tag, and does not leak the contact name', async () => {
    storeSeed = { byPhone: { id: 'existing', name: 'Real Customer', phone: '60123980112' } }
    db.contact = { name: 'Real Customer', phone: '60123980112', email: null }
    const body = await (await call({ claim: { phone: '60123980112' } })).json()
    expect(body.claimFound).toBe(true)
    expect(tagged).toEqual([])
    expect(body.identity.level).toBe('claimed')
    expect(body.identity.displayName).toBeNull()
    expect(JSON.stringify(body)).not.toContain('Real Customer')
  })

  it('an UNVERIFIED claim matching two contacts records a suggestion and never merges', async () => {
    storeSeed = { byPhone: { id: 'A' }, byEmail: { id: 'B' } }
    await call({ claim: { phone: '60123980112', email: 'b@example.com' } })
    expect(merges).toEqual([])
    expect(suggestions).toEqual([['A', 'B']])
    expect(visitorUpsert()).toMatchObject({ contact_id: 'A', identity_level: 'claimed' })
  })

  it('a VERIFIED token matching two contacts merges them', async () => {
    storeSeed = { byPhone: { id: 'A' }, byEmail: { id: 'B' } }
    const identityToken = signIdentityToken(SECRET, { phone: '60123980112', email: 'b@example.com' })
    await call({ identityToken })
    expect(merges).toEqual([['A', 'B']])
    expect(suggestions).toEqual([])
    expect(visitorUpsert()).toMatchObject({ contact_id: 'A', identity_level: 'verified' })
  })

  it('a returning GUEST browser that claims an identity has its guest contact folded in automatically', async () => {
    db.visitor = visitorRow()
    db.contact = { id: 'contact-guest', name: 'Website visitor', phone: '', email: null }
    storeSeed = { byPhone: { id: 'existing' } }
    await call({ claim: { phone: '60123980112' } })
    expect(rpcCalls).toEqual([
      {
        fn: 'merge_widget_guest_contact',
        args: { p_account_id: 'acc-1', p_guest_contact_id: 'contact-guest', p_target_contact_id: 'existing' },
      },
    ])
    expect(visitorUpsert()).toMatchObject({ contact_id: 'existing', identity_level: 'claimed' })
  })

  it('a returning CLAIMED browser is never folded/merged when it switches to a token identity', async () => {
    db.visitor = visitorRow({ contact_id: 'contact-claimed', identity_level: 'claimed', identity_source: 'typed' })
    db.contact = { id: 'contact-claimed', name: 'X', phone: '60111000111', email: null }
    storeSeed = { byPhone: { id: 'other' } }
    await call({ identityToken: signIdentityToken(SECRET, { phone: '60123980112' }) })
    expect(rpcCalls).toEqual([])
    expect(visitorUpsert()).toMatchObject({ contact_id: 'other', identity_level: 'verified' })
  })

  it('a VERIFIED returning browser ignores a typed claim (its identity is fixed)', async () => {
    db.visitor = visitorRow({ contact_id: 'c-v', identity_level: 'verified', identity_source: 'signed_app' })
    db.contact = { id: 'c-v', name: 'Jane', phone: '60123980112', email: null }
    storeSeed = { byPhone: { id: 'someone-else' } }
    const body = await (await call({ claim: { phone: '60999888777' } })).json()
    expect(body.identity.level).toBe('verified')
    expect(visitorUpsert()).toMatchObject({ contact_id: 'c-v', identity_level: 'verified' })
  })

  it('a returning browser resumes its stored level with nothing offered', async () => {
    db.visitor = visitorRow({ contact_id: 'c-c', identity_level: 'claimed', identity_source: 'typed' })
    db.contact = { id: 'c-c', name: 'X', phone: '60111000111', email: 'x@y.co' }
    const body = await (await call({})).json()
    expect(body).toMatchObject({ conversationId: 'conv-1', identity: { level: 'claimed', hasPhone: true, hasEmail: true } })
  })

  it('legacy verifiedIdentity is an unverified claim, never verified', async () => {
    const body = await (
      await call({ verifiedIdentity: { phone: '60123980112', walletId: 'w1' } })
    ).json()
    expect(body.identity.level).toBe('claimed')
    expect(visitorUpsert()).toMatchObject({ identity_level: 'claimed' })
  })

  it('an invalid claim is 400 invalid_claim', async () => {
    const res = await call({ claim: { phone: '12' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_claim' })
  })

  it('claims are rate limited per visitor: the 6th gets 429 rate_limited with Retry-After', async () => {
    for (let i = 0; i < 5; i++) {
      const ok = await call({ claim: { phone: `6012398011${i}` } })
      expect(ok.status).toBe(200)
    }
    const res = await call({ claim: { phone: '60123980119' } })
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(await res.json()).toMatchObject({ code: 'rate_limited' })
  })

  it('a valid token never spends the claim budget', async () => {
    for (let i = 0; i < 8; i++) {
      const res = await call({ identityToken: signIdentityToken(SECRET, { phone: '60123980112' }) })
      expect(res.status).toBe(200)
    }
  })

  it('404s for an unknown or disabled widget, 403 for a disallowed origin', async () => {
    db.config = null
    expect((await call({})).status).toBe(404)
    db.config = { ...baseConfig(), enabled: false }
    expect((await call({})).status).toBe(404)
    db.config = { ...baseConfig(), allowed_origins: ['https://only.example'] }
    expect((await call({})).status).toBe(403)
  })

  it('reports the configured verification mode', async () => {
    db.config = { ...baseConfig(), verification_mode: 'email_code' }
    const body = await (await call({})).json()
    expect(body.verification).toEqual({ mode: 'email_code' })
  })

  describe('email_code verification (migration 110)', () => {
    beforeEach(() => {
      db.config = { ...baseConfig(), verification_mode: 'email_code' }
    })

    it('a claim matching a contact with an email on file sends a code and asks for it, no contact created/merged', async () => {
      storeSeed = { byPhone: { id: 'existing', phone: '60123980112', email: 'real@example.com' } }
      const res = await call({ claim: { phone: '60123980112' } })
      const body = await res.json()
      expect(body).toMatchObject({
        needsIdentity: true,
        needsVerification: true,
        verification: { mode: 'email_code', maskedEmail: 'r***@example.com' },
      })
      expect(body.conversationId).toBeUndefined()
      expect(sentCodeEmails).toEqual([{ to: 'real@example.com', code: expect.any(String), widgetName: 'Support' }])
      expect(writes.some((w) => w.table === 'widget_visitors')).toBe(false)
      const codeWrite = writes.find((w) => w.table === 'widget_verification_codes')
      expect(codeWrite).toMatchObject({
        op: 'upsert',
        row: { widget_visitor_id: 'visitor-1', contact_id: 'existing', destination_email: 'real@example.com' },
      })
    })

    it('a claim matching nobody sends no code and falls back to needsIdentity', async () => {
      const res = await call({ claim: { phone: '60123980112' } })
      const body = await res.json()
      expect(body.needsVerification).toBeUndefined()
      expect(body.needsIdentity).toBe(true)
      expect(sentCodeEmails).toEqual([])
      expect(writes.some((w) => w.table === 'widget_verification_codes')).toBe(false)
    })

    it('a claim matching a contact with NO email on file sends no code either', async () => {
      storeSeed = { byPhone: { id: 'existing', phone: '60123980112', email: null } }
      const res = await call({ claim: { phone: '60123980112' } })
      const body = await res.json()
      expect(body.needsVerification).toBeUndefined()
      expect(sentCodeEmails).toEqual([])
    })

    it('a signed token bypasses email-code verification entirely (already the strong signal)', async () => {
      db.contact = { name: 'Jane', phone: '60123980112', email: null }
      const identityToken = signIdentityToken(SECRET, { phone: '60123980112' })
      const res = await call({ identityToken })
      const body = await res.json()
      expect(body.conversationId).toBe('conv-1')
      expect(body.identity.level).toBe('verified')
      expect(sentCodeEmails).toEqual([])
    })
  })
})
