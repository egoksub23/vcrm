// ============================================================
// Everything the gateway keeps: workspaces, users, one conversation per user,
// messages with a per-conversation sequence number, one-time connect sessions,
// and the outbox of events Halo has yet to receive.
//
// Rules this file holds:
//   * a sequence number is handed out inside the same transaction that stores
//     the message, so two writers can never get the same one;
//   * a send carrying an id seen before returns the original, never a second
//     message (client_id from the app, idempotency_key from Halo);
//   * a status only ever moves forward (sent, delivered, read);
//   * the event for Halo is written in the SAME transaction as the change it
//     describes, so a crash cannot lose it (the dispatcher is work package 2).
// ============================================================

import type { GatewayConfig } from './config'
import { decryptSecret, encryptSecret, newId, randomToken, sha256Hex } from './crypto'
import type { Db, Queryable } from './db'

export type MessageType = 'text' | 'image' | 'video' | 'audio' | 'document'
export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed'
export type Direction = 'in' | 'out'

export interface Workspace {
  id: string
  workspace_key: string
  name: string
  halo_webhook_url: string
  halo_signing_secret_enc: string
  push_settings: Record<string, unknown>
}

export interface User {
  id: string
  workspace_id: string
  wallet_id: string
  name: string | null
  phone: string | null
  email: string | null
}

export interface Conversation {
  id: string
  workspace_id: string
  user_id: string
  last_seq: number
}

export interface Message {
  id: string
  workspace_id: string
  conversation_id: string
  seq: number
  direction: Direction
  type: MessageType
  text: string | null
  media: Record<string, unknown> | null
  sender_name: string | null
  client_id: string | null
  idempotency_key: string | null
  status: MessageStatus
  created_at: string
  delivered_at: string | null
  read_at: string | null
}

/** Who a connection or a request is about: the user, their conversation and the workspace. */
export interface Subject {
  workspace: Workspace
  user: User
  conversation: Conversation
}

export interface Identity {
  walletId: string
  name?: string | null
  phone?: string | null
  email?: string | null
}

export const WORKSPACE_KEY_PATTERN = /^vcw_[A-Za-z0-9_-]{16,64}$/

const WORKSPACE_COLUMNS = 'id, workspace_key, name, halo_webhook_url, halo_signing_secret_enc, push_settings'
const MESSAGE_COLUMNS =
  'id, workspace_id, conversation_id, seq, direction, type, text, media, sender_name, client_id, idempotency_key, status, created_at, delivered_at, read_at'

const isUniqueViolation = (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'

export class Store {
  constructor(
    readonly db: Db,
    private readonly cfg: Pick<GatewayConfig, 'encryptionKey' | 'sessionTtlSeconds'>,
  ) {}

  // ----------------------------------------------------------
  // Workspaces
  // ----------------------------------------------------------

  /**
   * Register a Halo workspace. Halo generated the key, the signing secret and the API token (Settings,
   * Channels, Vircle Chat); the gateway keeps the secret encrypted and the token only as a hash. Returns
   * the SESSIONS KEY, shown once: the Vircle backend presents it to ask for chat sessions.
   */
  async createWorkspace(input: {
    key: string
    name: string
    haloWebhookUrl: string
    signingSecret: string
    apiToken: string
  }): Promise<{ workspace: Workspace; sessionsKey: string }> {
    if (!WORKSPACE_KEY_PATTERN.test(input.key)) throw new Error('The workspace key must look like vcw_ followed by 16 to 64 letters, digits, - or _')
    let url: URL
    try {
      url = new URL(input.haloWebhookUrl)
    } catch {
      throw new Error('The Halo webhook address is not a valid URL')
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      throw new Error('The Halo webhook address must start with https:// (http is allowed for localhost only)')
    }
    if (!input.signingSecret || !input.apiToken) throw new Error('The signing secret and the API token are required')

    const sessionsKey = randomToken('vgs_')
    const { rows } = await this.db.query<Workspace>(
      `INSERT INTO workspaces (id, workspace_key, name, halo_webhook_url, halo_signing_secret_enc, halo_api_token_hash, sessions_key_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${WORKSPACE_COLUMNS}`,
      [
        newId('w_'),
        input.key,
        input.name,
        url.toString(),
        encryptSecret(input.signingSecret, this.cfg.encryptionKey),
        sha256Hex(input.apiToken),
        sha256Hex(sessionsKey),
      ],
    )
    return { workspace: rows[0]!, sessionsKey }
  }

  async listWorkspaces(): Promise<Pick<Workspace, 'id' | 'workspace_key' | 'name' | 'halo_webhook_url'>[]> {
    const { rows } = await this.db.query<Pick<Workspace, 'id' | 'workspace_key' | 'name' | 'halo_webhook_url'>>(
      'SELECT id, workspace_key, name, halo_webhook_url FROM workspaces ORDER BY created_at',
    )
    return rows
  }

  async getWorkspaceByKey(key: string): Promise<Workspace | null> {
    const { rows } = await this.db.query<Workspace>(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE workspace_key = $1`, [key])
    return rows[0] ?? null
  }

  /** The workspace whose Halo presented this bearer token (Halo's REST calls), or null. */
  async authenticateHalo(bearer: string): Promise<Workspace | null> {
    const { rows } = await this.db.query<Workspace>(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE halo_api_token_hash = $1`,
      [sha256Hex(bearer)],
    )
    return rows[0] ?? null
  }

  /** The workspace whose Vircle backend presented this sessions key, or null. */
  async authenticateSessionsKey(bearer: string): Promise<Workspace | null> {
    const { rows } = await this.db.query<Workspace>(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE sessions_key_hash = $1`,
      [sha256Hex(bearer)],
    )
    return rows[0] ?? null
  }

  haloSigningSecret(workspace: Workspace): string {
    return decryptSecret(workspace.halo_signing_secret_enc, this.cfg.encryptionKey)
  }

  // ----------------------------------------------------------
  // Users and their one conversation
  // ----------------------------------------------------------

  /**
   * Find or create the user and their conversation. Name, phone and email are filled in when given and
   * never blanked by a call that leaves them out.
   */
  async upsertUser(workspace: Workspace, identity: Identity): Promise<Subject> {
    const { rows: userRows } = await this.db.query<User>(
      `INSERT INTO users (id, workspace_id, wallet_id, name, phone, email)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, wallet_id) DO UPDATE SET
         name  = COALESCE(EXCLUDED.name,  users.name),
         phone = COALESCE(EXCLUDED.phone, users.phone),
         email = COALESCE(EXCLUDED.email, users.email),
         updated_at = now()
       RETURNING id, workspace_id, wallet_id, name, phone, email`,
      [newId('u_'), workspace.id, identity.walletId, identity.name ?? null, identity.phone ?? null, identity.email ?? null],
    )
    const user = userRows[0]!
    await this.db.query(
      `INSERT INTO conversations (id, workspace_id, user_id) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
      [newId('c_'), workspace.id, user.id],
    )
    const { rows } = await this.db.query<Conversation>(
      'SELECT id, workspace_id, user_id, last_seq FROM conversations WHERE user_id = $1',
      [user.id],
    )
    return { workspace, user, conversation: rows[0]! }
  }

  async findSubjectByWallet(workspace: Workspace, walletId: string): Promise<Subject | null> {
    const { rows } = await this.db.query<User>(
      'SELECT id, workspace_id, wallet_id, name, phone, email FROM users WHERE workspace_id = $1 AND wallet_id = $2',
      [workspace.id, walletId],
    )
    const user = rows[0]
    if (!user) return null
    const conv = await this.db.query<Conversation>('SELECT id, workspace_id, user_id, last_seq FROM conversations WHERE user_id = $1', [user.id])
    return conv.rows[0] ? { workspace, user, conversation: conv.rows[0] } : null
  }

  // ----------------------------------------------------------
  // Connect sessions (one use, about a minute)
  // ----------------------------------------------------------

  async createSession(subject: Subject): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken('vcs_')
    const expiresAt = new Date(Date.now() + this.cfg.sessionTtlSeconds * 1000)
    await this.db.query('INSERT INTO sessions (token_hash, workspace_id, user_id, expires_at) VALUES ($1, $2, $3, $4)', [
      sha256Hex(token),
      subject.workspace.id,
      subject.user.id,
      expiresAt.toISOString(),
    ])
    return { token, expiresAt }
  }

  /** Spend a connect token. One atomic statement, so two connections cannot both use it. Null if unknown, used or expired. */
  async consumeSession(token: string): Promise<Subject | null> {
    const { rows } = await this.db.query<{ user_id: string; workspace_id: string }>(
      `UPDATE sessions SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id, workspace_id`,
      [sha256Hex(token)],
    )
    const s = rows[0]
    if (!s) return null
    const ws = await this.db.query<Workspace>(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = $1`, [s.workspace_id])
    const user = await this.db.query<User>('SELECT id, workspace_id, wallet_id, name, phone, email FROM users WHERE id = $1', [s.user_id])
    const conv = await this.db.query<Conversation>('SELECT id, workspace_id, user_id, last_seq FROM conversations WHERE user_id = $1', [s.user_id])
    if (!ws.rows[0] || !user.rows[0] || !conv.rows[0]) return null
    return { workspace: ws.rows[0], user: user.rows[0], conversation: conv.rows[0] }
  }

  /** Housekeeping: drop sessions that can no longer be used. */
  async purgeSessions(): Promise<number> {
    const r = await this.db.query(`DELETE FROM sessions WHERE expires_at < now() - interval '1 hour'`)
    return r.rowCount
  }

  // ----------------------------------------------------------
  // Messages
  // ----------------------------------------------------------

  /** A message from the user (the app's `send`). Idempotent on `clientId`. */
  async appendInbound(
    subject: Subject,
    input: { clientId: string | null; type: MessageType; text: string | null; media?: Record<string, unknown> | null },
  ): Promise<{ message: Message; duplicate: boolean }> {
    return this.append(subject, 'in', {
      clientId: input.clientId,
      idempotencyKey: null,
      type: input.type,
      text: input.text,
      media: input.media ?? null,
      senderName: subject.user.name,
    })
  }

  /** A message from Halo (a teammate or the AI). Idempotent on Halo's `Idempotency-Key`. */
  async appendOutbound(
    subject: Subject,
    input: { idempotencyKey: string; type: MessageType; text: string | null; media?: Record<string, unknown> | null; senderName: string | null },
  ): Promise<{ message: Message; duplicate: boolean }> {
    return this.append(subject, 'out', {
      clientId: null,
      idempotencyKey: input.idempotencyKey,
      type: input.type,
      text: input.text,
      media: input.media ?? null,
      senderName: input.senderName,
    })
  }

  private async append(
    subject: Subject,
    direction: Direction,
    m: { clientId: string | null; idempotencyKey: string | null; type: MessageType; text: string | null; media: Record<string, unknown> | null; senderName: string | null },
  ): Promise<{ message: Message; duplicate: boolean }> {
    const existing = () => this.findByIdempotency(subject, m.clientId, m.idempotencyKey)
    const prior = await existing()
    if (prior) return { message: prior, duplicate: true }

    try {
      const message = await this.db.tx(async (q) => {
        const seqRow = await q.query<{ last_seq: number }>(
          'UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq',
          [subject.conversation.id],
        )
        const seq = seqRow.rows[0]!.last_seq
        const { rows } = await q.query<Message>(
          `INSERT INTO messages (id, workspace_id, conversation_id, seq, direction, type, text, media, sender_name, client_id, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${MESSAGE_COLUMNS}`,
          [
            newId('m_'),
            subject.workspace.id,
            subject.conversation.id,
            seq,
            direction,
            m.type,
            m.text,
            m.media ? JSON.stringify(m.media) : null,
            m.senderName,
            m.clientId,
            m.idempotencyKey,
          ],
        )
        const message = rows[0]!
        if (direction === 'in') await this.enqueueInbound(q, subject, message)
        return message
      })
      return { message, duplicate: false }
    } catch (err) {
      // Two sends with the same id raced: the loser reads the winner's row.
      if (isUniqueViolation(err)) {
        const raced = await existing()
        if (raced) return { message: raced, duplicate: true }
      }
      throw err
    }
  }

  private async findByIdempotency(subject: Subject, clientId: string | null, idempotencyKey: string | null): Promise<Message | null> {
    if (clientId) {
      const { rows } = await this.db.query<Message>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 AND client_id = $2`,
        [subject.conversation.id, clientId],
      )
      if (rows[0]) return rows[0]
    }
    if (idempotencyKey) {
      const { rows } = await this.db.query<Message>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE workspace_id = $1 AND idempotency_key = $2`,
        [subject.workspace.id, idempotencyKey],
      )
      if (rows[0]) return rows[0]
    }
    return null
  }

  async getMessage(id: string): Promise<Message | null> {
    const { rows } = await this.db.query<Message>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = $1`, [id])
    return rows[0] ?? null
  }

  /** Messages with a sequence number above `afterSeq`, oldest first (what a reconnecting app missed). */
  async listAfter(conversationId: string, afterSeq: number, limit: number): Promise<Message[]> {
    const { rows } = await this.db.query<Message>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [conversationId, afterSeq, limit],
    )
    return rows
  }

  /**
   * The app reports it received (`delivered`) or showed (`read`) Halo's messages up to `upToSeq`. Moves
   * each affected message forward, never backward, and queues a receipt event for Halo for each one that
   * changed. Returns the messages that changed.
   */
  async applyReceipt(
    subject: Subject,
    upToSeq: number,
    status: 'delivered' | 'read',
  ): Promise<Message[]> {
    return this.db.tx(async (q) => {
      const from = status === 'delivered' ? `('sent')` : `('sent', 'delivered')`
      const { rows } = await q.query<Message>(
        `UPDATE messages
            SET status = $3,
                delivered_at = COALESCE(delivered_at, now()),
                read_at = CASE WHEN $3 = 'read' THEN now() ELSE read_at END
          WHERE conversation_id = $1 AND direction = 'out' AND seq <= $2 AND status IN ${from}
        RETURNING ${MESSAGE_COLUMNS}`,
        [subject.conversation.id, upToSeq, status],
      )
      for (const message of rows) await this.enqueueReceipt(q, subject.workspace, message, status)
      return rows
    })
  }

  // ----------------------------------------------------------
  // Events for Halo (transactional outbox; dispatched in work package 2)
  // ----------------------------------------------------------

  private async enqueueInbound(q: Queryable, subject: Subject, message: Message): Promise<void> {
    const payload = {
      event: 'message.inbound',
      event_id: newId('evt_'),
      workspace_key: subject.workspace.workspace_key,
      user: {
        wallet_id: subject.user.wallet_id,
        name: subject.user.name,
        phone: subject.user.phone,
        email: subject.user.email,
      },
      conversation_id: subject.conversation.id,
      message: {
        server_id: message.id,
        client_id: message.client_id,
        seq: message.seq,
        type: message.type,
        text: message.text,
        sent_at: new Date(message.created_at).toISOString(),
        // The download address of a file is added when the event is sent (work package 4).
        ...(message.media ? { media: message.media } : {}),
      },
    }
    await q.query('INSERT INTO outbox_events (id, workspace_id, kind, payload) VALUES ($1, $2, $3, $4)', [
      payload.event_id,
      subject.workspace.id,
      'message.inbound',
      JSON.stringify(payload),
    ])
  }

  private async enqueueReceipt(q: Queryable, workspace: Workspace, message: Message, status: 'delivered' | 'read'): Promise<void> {
    const payload = {
      event: 'message.receipt',
      event_id: newId('evt_'),
      workspace_key: workspace.workspace_key,
      server_id: message.id,
      status,
      at: new Date().toISOString(),
      error: null,
    }
    await q.query('INSERT INTO outbox_events (id, workspace_id, kind, payload) VALUES ($1, $2, $3, $4)', [
      payload.event_id,
      workspace.id,
      'message.receipt',
      JSON.stringify(payload),
    ])
  }

  async pendingEvents(workspaceId: string, limit = 100): Promise<{ id: string; kind: string; payload: Record<string, unknown> }[]> {
    const { rows } = await this.db.query<{ id: string; kind: string; payload: Record<string, unknown> }>(
      `SELECT id, kind, payload FROM outbox_events
        WHERE workspace_id = $1 AND dispatched_at IS NULL ORDER BY created_at, id LIMIT $2`,
      [workspaceId, limit],
    )
    return rows
  }
}
