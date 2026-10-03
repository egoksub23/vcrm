import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { testConfig } from '../src/config'
import type { Db } from '../src/db'
import { Store, type Subject, type Workspace } from '../src/store'
import { createTestDb, WORKSPACE } from './helpers'

let db: Db
let store: Store
let workspace: Workspace
let sessionsKey: string

beforeAll(async () => {
  db = await createTestDb()
  store = new Store(db, testConfig())
  const created = await store.createWorkspace(WORKSPACE)
  workspace = created.workspace
  sessionsKey = created.sessionsKey
})

afterAll(async () => {
  await db.close()
})

const identity = (walletId: string) => ({ walletId, name: 'Aisha', phone: '+60123456789', email: 'aisha@example.com' })

describe('workspaces', () => {
  it('keeps the signing secret encrypted and the tokens only as hashes', async () => {
    const { rows } = await db.query<Record<string, string>>('SELECT * FROM workspaces WHERE id = $1', [workspace.id])
    const row = rows[0]!
    expect(JSON.stringify(row)).not.toContain(WORKSPACE.signingSecret)
    expect(JSON.stringify(row)).not.toContain(WORKSPACE.apiToken)
    expect(JSON.stringify(row)).not.toContain(sessionsKey)
    expect(store.haloSigningSecret(workspace)).toBe(WORKSPACE.signingSecret)
  })

  it('recognises Halo by its API token and the Vircle backend by its sessions key, and nobody else', async () => {
    expect((await store.authenticateHalo(WORKSPACE.apiToken))?.id).toBe(workspace.id)
    expect((await store.authenticateSessionsKey(sessionsKey))?.id).toBe(workspace.id)
    expect(await store.authenticateHalo('wrong')).toBeNull()
    expect(await store.authenticateSessionsKey(WORKSPACE.apiToken)).toBeNull()
  })

  it('refuses a malformed key, an insecure webhook address and a missing secret', async () => {
    await expect(store.createWorkspace({ ...WORKSPACE, key: 'nope' })).rejects.toThrow(/workspace key/)
    await expect(store.createWorkspace({ ...WORKSPACE, key: 'vcw_zzzzzzzzzzzzzzzzzzzz', haloWebhookUrl: 'not a url' })).rejects.toThrow(/not a valid URL/)
    await expect(store.createWorkspace({ ...WORKSPACE, key: 'vcw_zzzzzzzzzzzzzzzzzzzz', haloWebhookUrl: 'http://halo.example.com/x' })).rejects.toThrow(/https/)
    await expect(store.createWorkspace({ ...WORKSPACE, key: 'vcw_zzzzzzzzzzzzzzzzzzzz', signingSecret: '' })).rejects.toThrow(/required/)
  })

  it('allows http for localhost only', async () => {
    const local = await store.createWorkspace({
      ...WORKSPACE,
      key: 'vcw_localhostlocalhost01',
      apiToken: 'vct_local',
      haloWebhookUrl: 'http://localhost:3000/api/vircle-chat/webhook',
    })
    expect(local.workspace.halo_webhook_url).toContain('localhost')
  })
})

describe('changing a workspace after Halo changes it', () => {
  it('takes a rotated signing secret and API token, and the old token stops working', async () => {
    const w = (await store.createWorkspace({ ...WORKSPACE, key: 'vcw_rotaterotaterotate1', apiToken: 'vct_old' })).workspace
    const updated = await store.updateWorkspace(w.workspace_key, { signingSecret: 'vcs_new', apiToken: 'vct_new' })
    expect(store.haloSigningSecret(updated)).toBe('vcs_new')
    expect((await store.authenticateHalo('vct_new'))?.id).toBe(w.id)
    expect(await store.authenticateHalo('vct_old')).toBeNull()
  })

  it('changes the webhook address (validated like a new one) and refuses an empty change or an unknown key', async () => {
    const w = (await store.createWorkspace({ ...WORKSPACE, key: 'vcw_addressaddress00001', apiToken: 'vct_addr' })).workspace
    expect((await store.updateWorkspace(w.workspace_key, { haloWebhookUrl: 'https://halo2.example.com/hook' })).halo_webhook_url).toBe('https://halo2.example.com/hook')
    await expect(store.updateWorkspace(w.workspace_key, { haloWebhookUrl: 'http://halo.example.com/hook' })).rejects.toThrow(/https/)
    await expect(store.updateWorkspace(w.workspace_key, {})).rejects.toThrow(/Nothing to change/)
    await expect(store.updateWorkspace(w.workspace_key, { signingSecret: '' })).rejects.toThrow(/empty/)
    await expect(store.updateWorkspace('vcw_doesnotexist000000001', { name: 'x' })).rejects.toThrow(/No workspace/)
  })

  it('rotates the sessions key: the new one works, the old one does not', async () => {
    const w = await store.createWorkspace({ ...WORKSPACE, key: 'vcw_sessionssessions001', apiToken: 'vct_sess' })
    const next = await store.rotateSessionsKey(w.workspace.workspace_key)
    expect((await store.authenticateSessionsKey(next))?.id).toBe(w.workspace.id)
    expect(await store.authenticateSessionsKey(w.sessionsKey)).toBeNull()
    await expect(store.rotateSessionsKey('vcw_doesnotexist000000001')).rejects.toThrow(/No workspace/)
  })
})

describe('users and conversations', () => {
  it('gives each user exactly one conversation, however often they are upserted', async () => {
    const a = await store.upsertUser(workspace, identity('W-one'))
    const b = await store.upsertUser(workspace, identity('W-one'))
    expect(b.user.id).toBe(a.user.id)
    expect(b.conversation.id).toBe(a.conversation.id)
    const { rows } = await db.query('SELECT 1 FROM conversations WHERE user_id = $1', [a.user.id])
    expect(rows).toHaveLength(1)
  })

  it('fills in details when given and never blanks one by leaving it out', async () => {
    await store.upsertUser(workspace, identity('W-keep'))
    const again = await store.upsertUser(workspace, { walletId: 'W-keep' })
    expect(again.user).toMatchObject({ name: 'Aisha', phone: '+60123456789', email: 'aisha@example.com' })
    const changed = await store.upsertUser(workspace, { walletId: 'W-keep', name: 'Aisha B' })
    expect(changed.user.name).toBe('Aisha B')
    expect(changed.user.phone).toBe('+60123456789')
  })

  it('finds a user by wallet id within the workspace only', async () => {
    await store.upsertUser(workspace, identity('W-find'))
    expect((await store.findSubjectByWallet(workspace, 'W-find'))?.user.wallet_id).toBe('W-find')
    expect(await store.findSubjectByWallet(workspace, 'W-missing')).toBeNull()
  })
})

describe('connect sessions', () => {
  it('can be spent once', async () => {
    const subject = await store.upsertUser(workspace, identity('W-sess'))
    const { token } = await store.createSession(subject)
    const first = await store.consumeSession(token)
    expect(first?.user.id).toBe(subject.user.id)
    expect(await store.consumeSession(token)).toBeNull()
  })

  it('cannot be spent twice at the same moment', async () => {
    const subject = await store.upsertUser(workspace, identity('W-race'))
    const { token } = await store.createSession(subject)
    const results = await Promise.all([store.consumeSession(token), store.consumeSession(token), store.consumeSession(token)])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('is refused once expired, and when unknown', async () => {
    const subject = await store.upsertUser(workspace, identity('W-exp'))
    const { token } = await store.createSession(subject)
    await db.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [subject.user.id])
    expect(await store.consumeSession(token)).toBeNull()
    expect(await store.consumeSession('vcs_unknown')).toBeNull()
  })

  it('stores only a hash of the token, and purges old ones', async () => {
    const subject = await store.upsertUser(workspace, identity('W-hash'))
    const { token } = await store.createSession(subject)
    const { rows } = await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id = $1', [subject.user.id])
    expect(rows[0]!.token_hash).not.toContain(token)
    await db.query(`UPDATE sessions SET expires_at = now() - interval '2 hours' WHERE user_id = $1`, [subject.user.id])
    expect(await store.purgeSessions()).toBeGreaterThanOrEqual(1)
  })
})

describe('messages', () => {
  let subject: Subject
  beforeAll(async () => {
    subject = await store.upsertUser(workspace, identity('W-msg'))
  })

  it('numbers messages 1, 2, 3 in the order they are stored, from either side', async () => {
    const a = await store.appendInbound(subject, { clientId: 'c1', type: 'text', text: 'hi' })
    const b = await store.appendOutbound(subject, { idempotencyKey: 'k1', type: 'text', text: 'hello', senderName: 'Sam' })
    const c = await store.appendInbound(subject, { clientId: 'c2', type: 'text', text: 'again' })
    expect([a.message.seq, b.message.seq, c.message.seq]).toEqual([1, 2, 3])
    expect(a.message.direction).toBe('in')
    expect(b.message.direction).toBe('out')
  })

  it('returns the original for a repeated client id and stores nothing new', async () => {
    const first = await store.appendInbound(subject, { clientId: 'dup', type: 'text', text: 'once' })
    const second = await store.appendInbound(subject, { clientId: 'dup', type: 'text', text: 'once, again' })
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    expect(second.message.id).toBe(first.message.id)
    expect(second.message.text).toBe('once')
  })

  it('returns the original for a repeated Halo idempotency key', async () => {
    const first = await store.appendOutbound(subject, { idempotencyKey: 'halo-1', type: 'text', text: 'x', senderName: null })
    const second = await store.appendOutbound(subject, { idempotencyKey: 'halo-1', type: 'text', text: 'x', senderName: null })
    expect(second.duplicate).toBe(true)
    expect(second.message.seq).toBe(first.message.seq)
  })

  it('hands out distinct, gap-free sequence numbers to simultaneous writers', async () => {
    const fresh = await store.upsertUser(workspace, identity('W-concurrent'))
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.appendOutbound(fresh, { idempotencyKey: `burst-${i}`, type: 'text', text: `m${i}`, senderName: null })),
    )
    expect(results.map((r) => r.message.seq).sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })

  it('absorbs the same id sent simultaneously, storing one message', async () => {
    const fresh = await store.upsertUser(workspace, identity('W-same-id'))
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.appendInbound(fresh, { clientId: 'same', type: 'text', text: 'once' })),
    )
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1)
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1)
    const { rows } = await db.query('SELECT 1 FROM messages WHERE conversation_id = $1', [fresh.conversation.id])
    expect(rows).toHaveLength(1)
  })

  it('lists what comes after a sequence number, oldest first, up to a limit', async () => {
    const fresh = await store.upsertUser(workspace, identity('W-list'))
    for (let i = 0; i < 5; i++) await store.appendOutbound(fresh, { idempotencyKey: `l-${i}`, type: 'text', text: `m${i}`, senderName: null })
    expect((await store.listAfter(fresh.conversation.id, 0, 100)).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
    expect((await store.listAfter(fresh.conversation.id, 3, 100)).map((m) => m.seq)).toEqual([4, 5])
    expect((await store.listAfter(fresh.conversation.id, 0, 2)).map((m) => m.seq)).toEqual([1, 2])
    expect(await store.listAfter(fresh.conversation.id, 5, 100)).toEqual([])
  })

  it('keeps one user\'s messages out of another user\'s conversation', async () => {
    const other = await store.upsertUser(workspace, identity('W-other'))
    const mine = await store.upsertUser(workspace, identity('W-mine'))
    await store.appendOutbound(other, { idempotencyKey: 'secret-1', type: 'text', text: 'private', senderName: null })
    expect(await store.listAfter(mine.conversation.id, 0, 100)).toEqual([])
  })
})

describe('receipts', () => {
  it('moves Halo\'s messages forward up to the sequence number, never backward', async () => {
    const s = await store.upsertUser(workspace, identity('W-rcpt'))
    const m1 = await store.appendOutbound(s, { idempotencyKey: 'r1', type: 'text', text: 'a', senderName: null })
    const m2 = await store.appendOutbound(s, { idempotencyKey: 'r2', type: 'text', text: 'b', senderName: null })
    const m3 = await store.appendOutbound(s, { idempotencyKey: 'r3', type: 'text', text: 'c', senderName: null })

    expect((await store.applyReceipt(s, m2.message.seq, 'delivered')).map((m) => m.seq)).toEqual([m1.message.seq, m2.message.seq])
    expect((await store.getMessage(m3.message.id))?.status).toBe('sent')

    // read goes past delivered
    expect(await store.applyReceipt(s, m1.message.seq, 'read')).toHaveLength(1)
    expect((await store.getMessage(m1.message.id))?.status).toBe('read')

    // a late "delivered" never pulls a read message back
    expect(await store.applyReceipt(s, m2.message.seq, 'delivered')).toEqual([])
    expect((await store.getMessage(m1.message.id))?.status).toBe('read')
  })

  it('does not touch the user\'s own messages', async () => {
    const s = await store.upsertUser(workspace, identity('W-rcpt-own'))
    const own = await store.appendInbound(s, { clientId: 'o1', type: 'text', text: 'mine' })
    expect(await store.applyReceipt(s, 10, 'read')).toEqual([])
    expect((await store.getMessage(own.message.id))?.status).toBe('sent')
  })

  it('queues one receipt event per message that changed, and none for one that did not', async () => {
    const s = await store.upsertUser(workspace, identity('W-rcpt-evt'))
    const m = await store.appendOutbound(s, { idempotencyKey: 're1', type: 'text', text: 'a', senderName: null })
    await store.applyReceipt(s, m.message.seq, 'delivered')
    await store.applyReceipt(s, m.message.seq, 'delivered')
    const events = (await store.pendingEvents(workspace.id, 1000)).filter(
      (e) => e.kind === 'message.receipt' && (e.payload as { server_id?: string }).server_id === m.message.id,
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({ event: 'message.receipt', status: 'delivered', workspace_key: workspace.workspace_key, error: null })
  })
})

describe('events for Halo', () => {
  it('writes a message.inbound event with the user\'s identity for each new message from the app, and none for a duplicate', async () => {
    const s = await store.upsertUser(workspace, identity('W-evt'))
    const first = await store.appendInbound(s, { clientId: 'e1', type: 'text', text: 'hello Halo' })
    await store.appendInbound(s, { clientId: 'e1', type: 'text', text: 'hello Halo' })
    const events = (await store.pendingEvents(workspace.id, 1000)).filter(
      (e) => e.kind === 'message.inbound' && (e.payload as { message?: { server_id?: string } }).message?.server_id === first.message.id,
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({
      event: 'message.inbound',
      workspace_key: workspace.workspace_key,
      user: { wallet_id: 'W-evt', name: 'Aisha', phone: '+60123456789', email: 'aisha@example.com' },
      conversation_id: s.conversation.id,
      message: { client_id: 'e1', seq: first.message.seq, type: 'text', text: 'hello Halo' },
    })
    expect((events[0]!.payload as { event_id: string }).event_id).toBe(events[0]!.id)
  })

  it('writes no event for a message from Halo', async () => {
    const s = await store.upsertUser(workspace, identity('W-evt-out'))
    const m = await store.appendOutbound(s, { idempotencyKey: 'eo1', type: 'text', text: 'x', senderName: null })
    const events = (await store.pendingEvents(workspace.id, 1000)).filter((e) => JSON.stringify(e.payload).includes(m.message.id))
    expect(events).toEqual([])
  })

  it('loses nothing: a failed write rolls the message back with its event', async () => {
    const s = await store.upsertUser(workspace, identity('W-atomic'))
    await db.query('ALTER TABLE outbox_events ADD CONSTRAINT outbox_block CHECK (workspace_id <> $$' + workspace.id + '$$) NOT VALID')
    try {
      await expect(store.appendInbound(s, { clientId: 'atomic', type: 'text', text: 'x' })).rejects.toThrow()
    } finally {
      await db.query('ALTER TABLE outbox_events DROP CONSTRAINT outbox_block')
    }
    const { rows } = await db.query('SELECT 1 FROM messages WHERE conversation_id = $1', [s.conversation.id])
    expect(rows).toHaveLength(0)
    const conv = await db.query<{ last_seq: number }>('SELECT last_seq FROM conversations WHERE id = $1', [s.conversation.id])
    expect(conv.rows[0]!.last_seq).toBe(0)
  })
})

describe('deleting a workspace', () => {
  it('removes the workspace with its users, and refuses a key that does not exist; another workspace is untouched', async () => {
    const other = await store.createWorkspace({ ...WORKSPACE, key: 'vcw_deletedeletedeletede1', name: 'To delete', apiToken: 'another-api-token-for-the-delete-test' })
    await store.upsertUser(other.workspace, identity('wallet-to-delete'))
    await store.upsertUser(workspace, identity('wallet-stays'))

    const removed = await store.deleteWorkspace(other.workspace.workspace_key)
    expect(removed.users).toBe(1)
    expect((await store.listWorkspaces()).map((w) => w.workspace_key)).not.toContain(other.workspace.workspace_key)
    const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM users WHERE workspace_id = $1', [other.workspace.id])
    expect(Number(rows[0]!.n)).toBe(0)
    // the first workspace and its user are still there
    expect((await store.listWorkspaces()).map((w) => w.workspace_key)).toContain(workspace.workspace_key)
    const kept = await db.query<{ n: string }>('SELECT count(*) AS n FROM users WHERE workspace_id = $1', [workspace.id])
    expect(Number(kept.rows[0]!.n)).toBeGreaterThanOrEqual(1)

    await expect(store.deleteWorkspace('vcw_doesnotexistdoesnot1')).rejects.toThrow(/No workspace has the key/)
  })
})
