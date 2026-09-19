import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

// A tiny in-memory stand-in for the parts of supabase-js the comments
// module uses, so the ingest / webhook / action logic can be tested
// without a database. Test-only.

type Row = Record<string, unknown>
type Filter = (r: Row) => boolean

export interface FakeDb {
  db: SupabaseClient
  tables: Record<string, Row[]>
  rpcCalls: { name: string; args: Record<string, unknown> }[]
}

const CONFLICT_KEYS: Record<string, string[]> = {
  comment_posts: ['account_id', 'provider', 'external_post_id'],
  comments: ['account_id', 'provider', 'external_comment_id'],
  comment_webhook_events: ['provider', 'dedupe_key'],
  contacts: ['id'],
}

export function makeFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ id: randomUUID(), ...r }))
  const rpcCalls: FakeDb['rpcCalls'] = []
  const rows = (t: string) => (tables[t] ??= [])

  function builder(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
    let payload: Row | Row[] | null = null
    let onConflict: string[] | null = null
    const filters: Filter[] = []
    let limitN = Infinity
    let embedPost = false
    let orderBy: { col: string; asc: boolean } | null = null
    let selectAfter = false
    let error: { code?: string; message: string } | null = null

    const api = {
      select(cols?: string) {
        if (op === 'select') embedPost = !!cols && cols.includes('post:comment_posts')
        else selectAfter = true
        return api
      },
      insert(p: Row | Row[]) { op = 'insert'; payload = p; return api },
      update(p: Row) { op = 'update'; payload = p; return api },
      upsert(p: Row | Row[], o?: { onConflict?: string }) { op = 'upsert'; payload = p; onConflict = o?.onConflict?.split(',') ?? null; return api },
      delete() { op = 'delete'; return api },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return api },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return api },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return api },
      in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return api },
      like(c: string, pat: string) {
        const re = new RegExp('^' + pat.replace(/%/g, '.*') + '$')
        filters.push((r) => re.test(String(r[c] ?? '')))
        return api
      },
      // PostgREST or(): `col.eq.X,col.neq.Y,col.is.null` — match any.
      or(expr: string) {
        const terms = expr.split(',').map((p) => {
          const [col, op, ...rest] = p.split('.')
          return { col, op, val: rest.join('.') }
        })
        filters.push((r) =>
          terms.some(({ col, op, val }) => {
            const v = r[col]
            if (op === 'eq') return String(v) === val
            if (op === 'neq') return v !== undefined && v !== null && String(v) !== val
            if (op === 'is') return val === 'null' ? v === null || v === undefined : String(v) === val
            return false
          }),
        )
        return api
      },
      order(c: string, o?: { ascending?: boolean }) { orderBy = { col: c, asc: o?.ascending !== false }; return api },
      limit(n: number) { limitN = n; return api },
      maybeSingle() { return run(true, false) },
      single() { return run(true, true) },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return run(false, false).then(res, rej) },
    }

    async function run(one: boolean, mustExist: boolean) {
      const match = (r: Row) => filters.every((f) => f(r))
      let out: Row[] = []

      if (op === 'insert' || op === 'upsert') {
        for (const p of Array.isArray(payload) ? (payload as Row[]) : [payload as Row]) {
          const keys = onConflict ?? CONFLICT_KEYS[table]
          const existing = keys ? rows(table).find((r) => keys.every((k) => r[k] === p[k])) : undefined
          if (existing) {
            if (op === 'upsert') { Object.assign(existing, p); out.push(existing) }
            else error = { code: '23505', message: 'duplicate key value violates unique constraint' }
          } else {
            const row = { id: randomUUID(), ...p }
            rows(table).push(row)
            out.push(row)
          }
        }
        if (op === 'insert' && !selectAfter) out = []
      } else if (op === 'update') {
        out = rows(table).filter(match)
        for (const r of out) Object.assign(r, payload as Row)
      } else if (op === 'delete') {
        const gone = rows(table).filter(match)
        tables[table] = rows(table).filter((r) => !gone.includes(r))
        out = gone
      } else {
        out = rows(table).filter(match).map((r) => ({ ...r }))
        if (embedPost) {
          out = out.map((r) => ({ ...r, post: rows('comment_posts').find((p) => p.id === r.post_id) ?? null }))
        }
        if (orderBy) {
          const { col, asc } = orderBy
          out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1))
        }
      }

      out = out.slice(0, limitN)
      if (error) return { data: null, error }
      if (one) {
        if (out.length === 0) return mustExist ? { data: null, error: { message: 'no rows' } } : { data: null, error: null }
        return { data: out[0], error: null }
      }
      return { data: out, error: null }
    }
    return api
  }

  const db = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      return { data: null, error: null }
    },
  } as unknown as SupabaseClient
  return { db, tables, rpcCalls }
}
