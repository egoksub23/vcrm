// Operations: what the gateway forgets (retention), what it reports (metrics), how it logs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { testConfig } from '../src/config'
import type { Db } from '../src/db'
import { requireUtf8 } from '../src/db'
import { createLogger } from '../src/log'
import { runRetention, UNDELIVERED_FACTOR } from '../src/retention'
import { Store, type Subject, type Workspace } from '../src/store'
import { createTestDb, startHarness, WORKSPACE, type Harness } from './helpers'

const DAY = 86_400_000

describe('retention', () => {
  let db: Db
  let store: Store
  let workspace: Workspace
  let subject: Subject

  beforeAll(async () => {
    db = await createTestDb()
    store = new Store(db, testConfig())
    workspace = (await store.createWorkspace(WORKSPACE)).workspace
    subject = await store.upsertUser(workspace, { walletId: 'W-ret', name: 'Aisha', phone: null, email: null })
  })
  afterAll(async () => {
    await db.close()
  })

  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
  const count = async (table: string) => Number((await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n)

  async function message(key: string, opts: { status: 'sent' | 'delivered' | 'read'; ageDays: number; media?: unknown }) {
    const { message: m } = await store.appendOutbound(subject, { idempotencyKey: key, type: 'text', text: key, senderName: null })
    await db.query(
      `UPDATE messages SET status = $2, created_at = $3, delivered_at = CASE WHEN $2 = 'sent' THEN NULL ELSE $3::timestamptz END, media = $4 WHERE id = $1`,
      [m.id, opts.status, ago(opts.ageDays), opts.media ? JSON.stringify(opts.media) : null],
    )
    return m
  }

  it('purges delivered messages after the retention period, and keeps undelivered ones three times as long', async () => {
    const freshDelivered = await message('fresh-d', { status: 'delivered', ageDays: 5 })
    const oldDelivered = await message('old-d', { status: 'delivered', ageDays: 31 })
    const oldRead = await message('old-r', { status: 'read', ageDays: 45 })
    const oldUndelivered = await message('old-u', { status: 'sent', ageDays: 40 })
    const staleUndelivered = await message('stale-u', { status: 'sent', ageDays: 30 * UNDELIVERED_FACTOR + 1 })

    const r = await runRetention(db, { days: 30 })
    expect(r.messages).toBe(3)

    const left = (await db.query<{ id: string }>('SELECT id FROM messages')).rows.map((x) => x.id)
    expect(left).toContain(freshDelivered.id)
    expect(left).toContain(oldUndelivered.id)
    expect(left).not.toContain(oldDelivered.id)
    expect(left).not.toContain(oldRead.id)
    expect(left).not.toContain(staleUndelivered.id)
  })

  it('never restarts a conversation sequence: the next message follows the highest ever used', async () => {
    const before = (await db.query<{ last_seq: number }>('SELECT last_seq FROM conversations WHERE id = $1', [subject.conversation.id])).rows[0]!.last_seq
    await db.query(`UPDATE messages SET status = 'read', read_at = $1, created_at = $1`, [ago(60)])
    await runRetention(db, { days: 30 })
    expect(await count('messages')).toBe(0)
    const next = await store.appendOutbound(subject, { idempotencyKey: 'after-purge', type: 'text', text: 'x', senderName: null })
    expect(next.message.seq).toBe(before + 1)
  })

  it('purges a file once no message uses it, but not a file in use, a recent upload, or a pending slot', async () => {
    const file = (id: string, ageDays: number, status = 'ready') =>
      db.query(
        `INSERT INTO files (id, workspace_id, conversation_id, origin, kind, mime_type, size_bytes, status, data, expires_at, created_at)
         VALUES ($1, $2, $3, 'app', 'image', 'image/png', 4, $4, $5, now() + interval '1 day', $6)`,
        [id, workspace.id, subject.conversation.id, status, status === 'ready' ? Buffer.from([1, 2, 3, 4]) : null, ago(ageDays)],
      )
    await file('f_used', 90)
    await file('f_orphan_old', 3)
    await file('f_orphan_new', 0.1)
    await file('f_pending', 3, 'pending')
    await message('with-file', { status: 'sent', ageDays: 1, media: { file_id: 'f_used', mime_type: 'image/png' } })

    const r = await runRetention(db, { days: 30 })
    expect(r.files).toBe(1)
    const left = (await db.query<{ id: string }>('SELECT id FROM files ORDER BY id')).rows.map((x) => x.id)
    expect(left).toEqual(['f_orphan_new', 'f_pending', 'f_used'])
  })

  it('purges events Halo has, and old given-up ones, but never one still waiting', async () => {
    const event = (id: string, state: 'sent' | 'failed' | 'pending', ageDays: number) =>
      db.query(
        `INSERT INTO outbox_events (id, workspace_id, kind, payload, created_at, dispatched_at, failed_at)
         VALUES ($1, $2, 'message.inbound', '{}'::jsonb, $3, $4, $5)`,
        [id, workspace.id, ago(ageDays), state === 'sent' ? ago(ageDays) : null, state === 'failed' ? ago(ageDays) : null],
      )
    await db.query('DELETE FROM outbox_events')
    await event('e_sent_old', 'sent', 40)
    await event('e_sent_new', 'sent', 2)
    await event('e_failed_40', 'failed', 40)
    await event('e_failed_100', 'failed', 100)
    await event('e_pending_old', 'pending', 200)

    const r = await runRetention(db, { days: 30 })
    expect(r.events).toBe(2)
    const left = (await db.query<{ id: string }>('SELECT id FROM outbox_events ORDER BY id')).rows.map((x) => x.id)
    expect(left).toEqual(['e_failed_40', 'e_pending_old', 'e_sent_new'])
  })

  it('purges the push log and sessions that can no longer be used', async () => {
    await store.logPush({ workspaceId: workspace.id, conversationId: subject.conversation.id, messageId: null, outcome: 'sent' })
    await store.logPush({ workspaceId: workspace.id, conversationId: subject.conversation.id, messageId: null, outcome: 'failed' })
    await db.query(`UPDATE push_log SET created_at = $1 WHERE outcome = 'sent'`, [ago(40)])
    await db.query('DELETE FROM sessions')
    await store.createSession(subject)
    await store.createSession(subject)
    await db.query(`UPDATE sessions SET expires_at = $1 WHERE token_hash = (SELECT token_hash FROM sessions LIMIT 1)`, [new Date(Date.now() - 2 * 3_600_000).toISOString()])

    const r = await runRetention(db, { days: 30 })
    expect(r.pushLog).toBe(1)
    expect(r.sessions).toBe(1)
    expect(await count('sessions')).toBe(1)
  })

  it('works through more rows than one batch', async () => {
    await db.query(
      `INSERT INTO messages (id, workspace_id, conversation_id, seq, direction, type, text, status, created_at, delivered_at)
       SELECT 'm_bulk_' || g, $1, $2, 100000 + g, 'out', 'text', 'x', 'delivered', $3, $3 FROM generate_series(1, 4500) g`,
      [workspace.id, subject.conversation.id, ago(50)],
    )
    expect(await count('messages')).toBeGreaterThanOrEqual(4500)
    const r = await runRetention(db, { days: 30 })
    expect(r.messages).toBeGreaterThanOrEqual(4500)
    expect(Number((await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM messages WHERE id LIKE 'm_bulk_%'`)).rows[0]!.n)).toBe(0)
  })

  it('does nothing, and says so, when there is nothing old', async () => {
    const r = await runRetention(db, { days: 30 })
    expect(r).toEqual({ messages: 0, files: 0, events: 0, pushLog: 0, sessions: 0 })
  })
})

describe('GET /metrics', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness({ cfg: { metricsToken: 'mt_secret' } })
  })
  afterAll(async () => {
    await h.close()
  })

  it('needs the token', async () => {
    expect((await fetch(`${h.url}/metrics`)).status).toBe(401)
    expect((await fetch(`${h.url}/metrics`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(`${h.url}/metrics`, { headers: { authorization: 'Bearer mt_secret' } })).status).toBe(200)
  })

  it('reports the queues in the Prometheus text format, as numbers that move', async () => {
    const get = async () => {
      const res = await fetch(`${h.url}/metrics`, { headers: { authorization: 'Bearer mt_secret' } })
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
      const out: Record<string, number> = {}
      for (const line of (await res.text()).split('\n')) {
        const m = /^(vircle_gateway_\w+) (\S+)$/.exec(line)
        if (m) out[m[1]!] = Number(m[2])
      }
      return out
    }
    const before = await get()
    expect(before).toMatchObject({ vircle_gateway_connections: 0, vircle_gateway_outbox_pending: 0, vircle_gateway_users: 0 })
    expect(before.vircle_gateway_process_rss_bytes).toBeGreaterThan(0)

    const subject = await h.gw.store.upsertUser(h.workspace, { walletId: 'W-metrics', name: 'Aisha', phone: null, email: null })
    await h.gw.store.appendInbound(subject, { clientId: 'c1', type: 'text', text: 'hi' })
    await h.gw.store.appendOutbound(subject, { idempotencyKey: 'k1', type: 'text', text: 'hello', senderName: null })
    const after = await get()
    expect(after.vircle_gateway_users).toBe(1)
    expect(after.vircle_gateway_outbox_pending).toBe(1)
    expect(after.vircle_gateway_messages_in_1h).toBe(1)
    expect(after.vircle_gateway_messages_out_1h).toBe(1)
    expect(after.vircle_gateway_undelivered).toBe(1)
    expect(after.vircle_gateway_undelivered_oldest_seconds).toBeGreaterThanOrEqual(0)
  })

  it('is not there at all when no token is configured', async () => {
    const plain = await startHarness()
    try {
      expect((await fetch(`${plain.url}/metrics`)).status).toBe(404)
      expect((await fetch(`${plain.url}/metrics`, { headers: { authorization: 'Bearer anything' } })).status).toBe(404)
    } finally {
      await plain.close()
    }
  })
})

describe('GET /readyz', () => {
  it('answers 200 while the database answers, and 503 when it does not, while /healthz stays up', async () => {
    const h = await startHarness()
    try {
      expect(await (await fetch(`${h.url}/readyz`)).json()).toMatchObject({ ok: true })
      const original = h.gw.store.ping.bind(h.gw.store)
      h.gw.store.ping = async () => {
        throw new Error('database did not answer')
      }
      const down = await fetch(`${h.url}/readyz`)
      expect(down.status).toBe(503)
      expect(await down.json()).toEqual({ ok: false, error: 'database_unavailable' })
      expect((await fetch(`${h.url}/healthz`)).status).toBe(200)
      h.gw.store.ping = original
      expect((await fetch(`${h.url}/readyz`)).status).toBe(200)
    } finally {
      await h.close()
    }
  })
})

describe('the database encoding', () => {
  it('is accepted when UTF-8, and refused with a clear reason when it is not', async () => {
    await expect(requireUtf8({ query: (async () => ({ rows: [{ server_encoding: 'UTF8' }], rowCount: 1 })) as never })).resolves.toBeUndefined()
    await expect(requireUtf8({ query: (async () => ({ rows: [{ server_encoding: 'WIN1252' }], rowCount: 1 })) as never })).rejects.toThrow(/must be UTF8/)
  })

  it('is UTF-8 on the database the tests run on, so emoji are stored as written', async () => {
    const db = await createTestDb()
    try {
      await expect(requireUtf8(db)).resolves.toBeUndefined()
    } finally {
      await db.close()
    }
  })
})

describe('logging', () => {
  const capture = (opts: Parameters<typeof createLogger>[0] = {}) => {
    const lines: { level: string; line: string }[] = []
    const logger = createLogger({ silent: false, level: 'info', write: (level, line) => lines.push({ level, line }), ...opts })
    return { logger, lines }
  }

  it('writes one JSON object per line, with the component and the fields', () => {
    const { logger, lines } = capture()
    logger.child('dispatcher').warn('Halo answered 503', { workspace: 'ws_1', attempt: 2 })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.level).toBe('warn')
    expect(JSON.parse(lines[0]!.line)).toMatchObject({ level: 'warn', component: 'dispatcher', msg: 'Halo answered 503', workspace: 'ws_1', attempt: 2 })
    expect(JSON.parse(lines[0]!.line).t).toMatch(/^\d{4}-\d\d-\d\dT/)
  })

  it('leaves out what is below the level, and prints text on request', () => {
    const quiet = capture({ level: 'warn' })
    quiet.logger.info('hidden')
    quiet.logger.debug('hidden')
    quiet.logger.error('shown')
    expect(quiet.lines.map((l) => JSON.parse(l.line).msg)).toEqual(['shown'])

    const text = capture({ text: true })
    text.logger.child('ws').info('connected', { n: 3 })
    expect(text.lines[0]!.line).toMatch(/INFO\s+\[ws\] connected {"n":3}$/)
  })
})
