// ============================================================
// /api/sembang/channels/[id]/presence
//
//   POST {name:string, avatarUrl?:string} — record that the caller is
//          viewing this channel right now. TTL 30 s; call every 15 s.
//          Returns 204.
//
//   GET  — return the list of members currently in this channel (entries
//          < 30 s old), excluding the caller.
//          Returns {present:[{userId,name,avatarUrl}]}.
//
// Architecture mirrors typing/route.ts: module-level in-memory store,
// no DB migration, ephemeral / best-effort.
// MULTI-TENANCY: store key = "${accountId}:${channelId}" (never bare channelId).
// ============================================================
import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'

interface PresenceEntry {
  name: string;
  avatarUrl: string | null;
  ts: number;
}

const store = new Map<string, Map<string, PresenceEntry>>()

const STALE_MS   = 45_000 // prune on write (1.5× TTL)
const VISIBLE_MS = 30_000 // visible on read

function channelMap(accountId: string, channelId: string): Map<string, PresenceEntry> {
  const key = `${accountId}:${channelId}`
  let m = store.get(key)
  if (!m) { m = new Map(); store.set(key, m) }
  return m
}

function pruneStale(m: Map<string, PresenceEntry>): void {
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

    const payload = (await request.json().catch(() => null)) as { name?: unknown; avatarUrl?: unknown } | null
    const name      = typeof payload?.name      === 'string' ? payload.name.slice(0, 100)      : ''
    const avatarUrl = typeof payload?.avatarUrl === 'string' ? payload.avatarUrl.slice(0, 500)  : null

    const m = channelMap(ctx.accountId, channelId)
    pruneStale(m)
    m.set(ctx.userId, { name, avatarUrl, ts: Date.now() })

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
    if (!m) return NextResponse.json({ present: [] })

    const cutoff = Date.now() - VISIBLE_MS
    const present: { userId: string; name: string; avatarUrl: string | null }[] = []
    for (const [uid, entry] of m) {
      if (uid !== ctx.userId && entry.ts >= cutoff) {
        present.push({ userId: uid, name: entry.name, avatarUrl: entry.avatarUrl })
      }
    }

    return NextResponse.json({ present })
  } catch (err) {
    return toErrorResponse(err)
  }
}
