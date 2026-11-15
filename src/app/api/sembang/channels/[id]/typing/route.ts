// ============================================================
// /api/sembang/channels/[id]/typing
//
//   POST {name:string} — record that the authenticated user is typing
//          in this channel. Cleans up entries older than 10 s.
//          Returns 204 (no body).
//
//   GET  — return the list of users currently typing (entries < 4 s old),
//          excluding the requesting user. Returns {typing:[{userId,name}]}.
//
// The store is module-level (in-memory, single process). No DB migration
// needed — typing indicators are ephemeral and best-effort only.
// ============================================================
import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'

interface TypingEntry {
  name: string;
  ts: number;
}

/** "accountId:channelId" → Map(userId → entry)
 *
 *  MULTI-TENANCY: The key MUST include accountId so that tenant A
 *  cannot observe or overwrite tenant B's typing indicators even if
 *  a channel id happens to collide across tenants (e.g. sequential
 *  UUIDs that could theoretically be guessed).
 */
const store = new Map<string, Map<string, TypingEntry>>()

const STALE_MS = 10_000  // entries older than this are pruned on write
const VISIBLE_MS = 4_000 // entries older than this are hidden on read

function channelMap(accountId: string, channelId: string): Map<string, TypingEntry> {
  const key = `${accountId}:${channelId}`
  let m = store.get(key)
  if (!m) {
    m = new Map()
    store.set(key, m)
  }
  return m
}

function pruneStale(m: Map<string, TypingEntry>): void {
  const cutoff = Date.now() - STALE_MS
  for (const [uid, entry] of m) {
    if (entry.ts < cutoff) m.delete(uid)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const payload = (await request.json().catch(() => null)) as { name?: unknown } | null
    const name = typeof payload?.name === 'string' ? payload.name.slice(0, 100) : ''

    const m = channelMap(ctx.accountId, channelId)
    pruneStale(m)
    m.set(ctx.userId, { name, ts: Date.now() })

    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const m = store.get(`${ctx.accountId}:${channelId}`)
    if (!m) return NextResponse.json({ typing: [] })

    const cutoff = Date.now() - VISIBLE_MS
    const typing: { userId: string; name: string }[] = []
    for (const [uid, entry] of m) {
      if (uid !== ctx.userId && entry.ts >= cutoff) {
        typing.push({ userId: uid, name: entry.name })
      }
    }

    return NextResponse.json({ typing })
  } catch (err) {
    return toErrorResponse(err)
  }
}
