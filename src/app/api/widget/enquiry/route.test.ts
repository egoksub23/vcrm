import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetRateLimitForTests } from '@/lib/rate-limit'
import type { IdentityStore } from '@/lib/widget/identity-resolve'

interface FakeDb {
  config: Record<string, unknown> | null
  visitor: Record<string, unknown> | null
}
let db: FakeDb
const writes: { table: string; op: string; row: unknown }[] = []
const rpcCalls: { fn: string; args: unknown }[] = []
const tagged: string[] = []
const fanout = vi.fn()
const insertMessage = vi.fn()
const automations = vi.fn()

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
    if (table === 'contacts') return { data: { name: 'Aisyah', phone: '60123980112', email: null }, error: null }
    if (table === 'conversations') return { data: { id: 'conv-1', status: 'open' }, error: null }
    return { data: null, error: null }
  }
  self.maybeSingle = async () => result()
  self.single = async () => ({ data: { id: 'x' }, error: null })
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
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: (...a: unknown[]) => automations(...a) }))
vi.mock('@/lib/widget/session-identity', () => ({ findOrCreatePrimaryConversation: vi.fn(async () => 'conv-1') }))
vi.mock('@/lib/widget/tags', async () => {
  const actual = await vi.importActual<typeof import('@/lib/widget/tags')>('@/lib/widget/tags')
  return { ...actual, applyContactTagByName: vi.fn(async (_db: unknown, a: { name: string }) => void tagged.push(a.name)) }
})
vi.mock('@/lib/widget/inbound', () => ({
  isFirstCustomerMessage: vi.fn(async () => true),
  insertWidgetCustomerMessage: (...a: unknown[]) => insertMessage(...a),
  runWidgetInboundFanout: (...a: unknown[]) => fanout(...a),
}))

let matched: { id: string } | null = null
vi.mock('@/lib/widget/identity-resolve', async () => {
  const actual = await vi.importActual<typeof import('@/lib/widget/identity-resolve')>('@/lib/widget/identity-resolve')
  const store: IdentityStore = {
    findByPhone: async () => (matched as never) ?? null,
    findByEmail: async () => null,
    findByWallet: async () => null,
    createContact: async () => ({ id: 'created-contact', created: true }),
    backfill: async () => undefined,
    mergeContacts: async () => true,
    recordSuggestion: async () => undefined,
  }
  return { ...actual, createSupabaseIdentityStore: () => store }
})

import { POST } from './route'

const config = () => ({
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
})

const valid = {
  widgetToken: 'wt_1',
  name: 'Aisyah',
  phone: '+60123980112',
  role: 'parent',
  message: 'How do I enrol?',
  consent: true,
  locale: 'ms',
}

let ip = 0
function call(body: Record<string, unknown>) {
  return POST(
    new Request('https://crm.example/api/widget/enquiry', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://site.example',
        Authorization: 'Bearer jwt',
        'x-forwarded-for': `10.1.0.${++ip}`,
      },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  __resetRateLimitForTests()
  db = { config: config(), visitor: null }
  writes.length = 0
  rpcCalls.length = 0
  tagged.length = 0
  matched = null
  fanout.mockReset()
  automations.mockReset()
  automations.mockResolvedValue(undefined)
  insertMessage.mockReset()
  insertMessage.mockResolvedValue({ id: 'msg-1', created_at: 't', status: 'sent', duplicate: false })
})

describe('POST /api/widget/enquiry', () => {
  it('saves a lead: tags, enquiry row with consent time, first message, fan-out, and the session-shaped answer', async () => {
    const res = await call(valid)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      needsIdentity: false,
      conversationId: 'conv-1',
      identity: { level: 'claimed', hasPhone: true, displayName: 'Aisyah' },
      claimFound: false,
      verification: { mode: 'none' },
    })
    expect(body.limits.allowedMimeTypes.length).toBeGreaterThan(0)

    expect(tagged).toEqual(['Web enquiry', 'Enquiry: parent'])
    expect(writes.find((w) => w.table === 'contacts' && w.op === 'update')?.row).toEqual({ lifecycle_stage: 'lead' })

    const enquiry = writes.find((w) => w.table === 'widget_enquiries')?.row as Record<string, unknown>
    expect(enquiry).toMatchObject({
      account_id: 'acc-1',
      contact_id: 'created-contact',
      conversation_id: 'conv-1',
      role: 'parent',
      message: 'How do I enrol?',
      phone: '60123980112',
      locale: 'ms',
    })
    expect(new Date(enquiry.consent_at as string).getTime()).toBeGreaterThan(Date.now() - 60_000)

    expect(insertMessage.mock.calls[0][1].text).toBe('[Web enquiry - Parent]\nHow do I enrol?')
    expect(fanout).toHaveBeenCalledTimes(1)
    expect(automations.mock.calls[0][0]).toMatchObject({ triggerType: 'new_contact_created', contactId: 'created-contact' })
    expect(writes.find((w) => w.table === 'widget_visitors' && w.op === 'upsert')?.row).toMatchObject({
      identity_level: 'claimed',
      identity_source: 'typed',
    })
  })

  it('an existing contact is matched (claimFound=true), still tagged, and is not re-created or made a lead', async () => {
    matched = { id: 'existing' }
    const body = await (await call(valid)).json()
    expect(body.claimFound).toBe(true)
    expect(tagged).toEqual(['Web enquiry', 'Enquiry: parent'])
    expect(writes.find((w) => w.table === 'contacts' && w.op === 'update')).toBeUndefined()
    expect(automations).not.toHaveBeenCalled()
  })

  it('folds a guest browser into the contact automatically', async () => {
    db.visitor = { contact_id: 'guest-contact', identity_level: 'guest', identity_source: null, identity_verified_at: null }
    await call(valid)
    expect(rpcCalls[0]).toMatchObject({ fn: 'merge_widget_guest_contact' })
  })

  it('keeps a VERIFIED browser on its verified contact (the typed form does not re-identify it)', async () => {
    db.visitor = {
      contact_id: 'verified-contact',
      identity_level: 'verified',
      identity_source: 'signed_app',
      identity_verified_at: '2026-01-01T00:00:00Z',
    }
    matched = { id: 'someone-else' }
    const body = await (await call(valid)).json()
    expect(body.identity.level).toBe('verified')
    expect(writes.find((w) => w.table === 'widget_visitors' && w.op === 'upsert')?.row).toMatchObject({
      contact_id: 'verified-contact',
      identity_level: 'verified',
    })
    expect(rpcCalls).toEqual([])
  })

  it.each([
    ['no consent', { consent: false }],
    ['consent as a string', { consent: 'true' }],
    ['no phone or email', { phone: undefined }],
    ['bad role', { role: 'student' }],
    ['empty message', { message: ' ' }],
    ['empty name', { name: '' }],
  ])('rejects %s with 400 and writes nothing', async (_label, patch) => {
    const res = await call({ ...valid, ...patch })
    expect(res.status).toBe(400)
    expect(writes.filter((w) => w.table === 'widget_enquiries')).toHaveLength(0)
    expect(fanout).not.toHaveBeenCalled()
  })

  it('a bad phone is invalid_claim', async () => {
    const res = await call({ ...valid, phone: '12' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_claim' })
  })

  it('is rate limited per visitor (5 per hour): the 6th is 429 rate_limited', async () => {
    for (let i = 0; i < 5; i++) expect((await call(valid)).status).toBe(200)
    const res = await call(valid)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ code: 'rate_limited' })
  })

  it('404s for a disabled or unknown widget', async () => {
    db.config = { ...config(), enabled: false }
    expect((await call(valid)).status).toBe(404)
  })
})
