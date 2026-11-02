// PostgREST-compatible query builder backed by postgres.js.
//
// Mirrors the Supabase JS client's fluent API so all existing call sites work
// unchanged. Returns { data, error } exactly as Supabase does.
//
// Embedded resources (PostgREST join syntax, e.g. select('*, messages(id)'))
// are resolved via a one-time cached information_schema lookup that discovers
// the FK relationship, then generates a lateral JSON-aggregation subquery.
//
// RLS is enforced by wrapping every user query in a short transaction that
// does SET LOCAL role='authenticated' and SET LOCAL request.jwt.claims so
// pg sees auth.uid() and auth.role() exactly as PostgREST would.

import type { Sql } from 'postgres'

// ---- types ---------------------------------------------------------------

export interface PgResult<T> {
  data: T | null
  error: { message: string; code?: string; details?: string; hint?: string } | null
  count?: number | null
}

interface SelectSpec {
  columns: ColSpec[]
}
interface ColSpec {
  raw: string
  embedded?: EmbeddedSpec
}
interface EmbeddedSpec {
  relation: string
  alias?: string   // "alias:table(*)" → alias stored here, relation is the real table name
  hint?: string    // !hint syntax — FK column or constraint name
  inner?: boolean  // !inner → INNER JOIN (skip rows with no match)
  select: SelectSpec
}

type WhereKind =
  | { k: 'simple'; col: string; op: string; val: unknown }
  | { k: 'no_val'; col: string; expr: string }  // IS NULL / IS NOT NULL / IS TRUE etc.
  | { k: 'in'; col: string; vals: unknown[] }
  | { k: 'array_op'; col: string; op: string; val: unknown }
  | { k: 'or'; raw: string }

// ---- FK cache (module-level; lives for the process lifetime) -------------

interface FkRow { fkTable: string; fkColumn: string; refTable: string; refColumn: string }
const _fkCache = new Map<string, FkRow[]>()

async function lookupFk(sql: Sql, tableA: string, tableB: string): Promise<FkRow[]> {
  const key = [tableA, tableB].sort().join('\x00')
  if (_fkCache.has(key)) return _fkCache.get(key)!
  const rows = await sql.unsafe<FkRow[]>(
    `SELECT
       tc.table_name    AS "fkTable",
       kcu.column_name  AS "fkColumn",
       ccu.table_name   AS "refTable",
       ccu.column_name  AS "refColumn"
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema    = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema   = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema    = 'public'
       AND (
             (tc.table_name = $1 AND ccu.table_name = $2)
          OR (tc.table_name = $2 AND ccu.table_name = $1)
           )`,
    [tableA, tableB],
  )
  _fkCache.set(key, rows)
  return rows
}

// ---- SQL identifier helpers ---------------------------------------------

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`

function mapOp(pgrestOp: string): string {
  const MAP: Record<string, string> = {
    eq: '=', neq: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=',
    like: 'LIKE', ilike: 'ILIKE', is: 'IS', in: 'IN',
    cs: '@>', cd: '<@', ov: '&&',
    fts: '@@', plfts: '@@', phfts: '@@', wfts: '@@',
  }
  return MAP[pgrestOp] ?? pgrestOp.toUpperCase()
}

function coerceOrVal(raw: string): unknown {
  if (raw === 'null') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw)
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  return raw
}

// Splits a string on commas at depth 0 (ignoring commas inside parentheses).
function topSplit(s: string): string[] {
  const out: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    else if (s[i] === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1 }
  }
  out.push(s.slice(start))
  return out
}

// ---- PostgREST select-spec parser ----------------------------------------
// Handles: *, col, alias:col, rel(cols...), rel!hint(cols...), rel!inner(cols...)

function parseSpec(raw: string): SelectSpec {
  const columns: ColSpec[] = []
  for (const token of topSplit(raw)) {
    const t = token.trim()
    if (!t) continue
    const pi = t.indexOf('(')
    if (pi < 0) { columns.push({ raw: t }); continue }
    const head = t.slice(0, pi).trim()
    const inner_spec = t.slice(pi + 1, t.lastIndexOf(')')).trim()
    const bang = head.indexOf('!')
    let relation = head, hint: string | undefined, inner = false
    if (bang >= 0) {
      relation = head.slice(0, bang)
      const rest = head.slice(bang + 1)
      if (rest === 'inner') inner = true; else hint = rest
    }
    // "alias:table(*)" PostgREST syntax: split alias from real table name.
    let embAlias: string | undefined
    const colonIdx = relation.indexOf(':')
    if (colonIdx >= 0) {
      embAlias = relation.slice(0, colonIdx)
      relation = relation.slice(colonIdx + 1)
    }
    columns.push({ raw: embAlias ?? relation, embedded: { relation, alias: embAlias, hint, inner, select: parseSpec(inner_spec) } })
  }
  return { columns }
}

// Build the SQL column expression for a direct (non-embedded) column token.
function colExpr(raw: string, tableAlias?: string): string {
  const t = raw.trim()
  if (t === '*') return tableAlias ? `${ident(tableAlias)}.*` : '*'
  // alias:col → col AS alias
  const ci = t.indexOf(':')
  if (ci >= 0) {
    const alias = t.slice(0, ci).trim()
    const col = t.slice(ci + 1).trim()
    const base = tableAlias ? `${ident(tableAlias)}.${ident(col)}` : ident(col)
    return `${base} AS ${ident(alias)}`
  }
  // Pass through casts and json operators from app code (trusted, not user input)
  if (t.includes('->') || t.includes('::') || t.includes('(')) return t
  return tableAlias ? `${ident(tableAlias)}.${ident(t)}` : ident(t)
}

// ---- OR filter string parser ---------------------------------------------
// Input: "name.ilike.%foo%,email.ilike.%foo%"

function parseOrStr(
  raw: string,
  addParam: (v: unknown) => string,
): string {
  return topSplit(raw).map(part => {
    const p = part.trim()
    const d1 = p.indexOf('.')
    const d2 = d1 >= 0 ? p.indexOf('.', d1 + 1) : -1
    if (d1 < 0 || d2 < 0) return 'FALSE'
    const col = p.slice(0, d1).trim()
    const op = p.slice(d1 + 1, d2).trim()
    const rawVal = p.slice(d2 + 1).trim()
    const pgOp = mapOp(op)
    if (op === 'is') {
      if (rawVal === 'null') return `${ident(col)} IS NULL`
      if (rawVal === 'true') return `${ident(col)} IS TRUE`
      if (rawVal === 'false') return `${ident(col)} IS FALSE`
      return `${ident(col)} IS NULL`
    }
    if (op === 'in') {
      const vals = rawVal.replace(/^\(|\)$/g, '').split(',').map(v => addParam(coerceOrVal(v.trim())))
      return `${ident(col)} IN (${vals.join(', ')})`
    }
    return `${ident(col)} ${pgOp} ${addParam(coerceOrVal(rawVal))}`
  }).join(' OR ')
}

// ---- main builder --------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class PgQueryBuilder<T = any> {
  private _sql: Sql
  private _schema: string
  private _table: string
  private _userId: string | null

  private _op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  private _selectRaw = '*'
  private _count: 'exact' | null = null
  private _headOnly = false

  private _wheres: WhereKind[] = []
  private _orders: Array<{ col: string; asc: boolean; nullsFirst?: boolean }> = []
  private _limit: number | null = null
  private _offset: number | null = null

  private _single = false
  private _maybeSingle = false

  private _insertVals: Record<string, unknown>[] | null = null
  private _updateVals: Record<string, unknown> | null = null
  private _conflictCols: string[] | null = null
  private _ignoreDups = false
  private _returning: string | null = null

  constructor(sql: Sql, schema: string, table: string, userId: string | null) {
    this._sql = sql
    this._schema = schema
    this._table = table
    this._userId = userId
  }

  // ---- operation setters -------------------------------------------------

  select(cols?: string, opts?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    this._op = 'select'
    this._selectRaw = cols ?? '*'
    this._count = opts?.count ? 'exact' : null
    this._headOnly = opts?.head === true
    return this
  }

  insert(vals: Record<string, unknown> | Record<string, unknown>[]): this {
    this._op = 'insert'
    this._insertVals = Array.isArray(vals) ? vals : [vals]
    return this
  }

  update(vals: Record<string, unknown>): this {
    this._op = 'update'
    this._updateVals = vals
    return this
  }

  delete(): this { this._op = 'delete'; return this }

  upsert(
    vals: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): this {
    this._op = 'upsert'
    this._insertVals = Array.isArray(vals) ? vals : [vals]
    if (opts?.onConflict) this._conflictCols = opts.onConflict.split(',').map(s => s.trim())
    this._ignoreDups = opts?.ignoreDuplicates ?? false
    return this
  }

  // ---- filters -----------------------------------------------------------

  eq(col: string, val: unknown): this { return this._w({ k: 'simple', col, op: '=', val }) }
  neq(col: string, val: unknown): this { return this._w({ k: 'simple', col, op: '!=', val }) }
  gt(col: string, val: unknown): this { return this._w({ k: 'simple', col, op: '>', val }) }
  lt(col: string, val: unknown): this { return this._w({ k: 'simple', col, op: '<', val }) }
  gte(col: string, val: unknown): this { return this._w({ k: 'simple', col, op: '>=', val }) }
  lte(col: string, val: unknown): this { return this._w({ k: 'simple', col, op: '<=', val }) }
  like(col: string, p: string): this { return this._w({ k: 'simple', col, op: 'LIKE', val: p }) }
  ilike(col: string, p: string): this { return this._w({ k: 'simple', col, op: 'ILIKE', val: p }) }

  is(col: string, val: null | boolean): this {
    if (val === null) return this._w({ k: 'no_val', col, expr: `${ident(col)} IS NULL` })
    return this._w({ k: 'no_val', col, expr: `${ident(col)} IS ${val ? 'TRUE' : 'FALSE'}` })
  }

  in(col: string, vals: unknown[]): this {
    return this._w({ k: 'in', col, vals })
  }

  contains(col: string, val: unknown): this { return this._w({ k: 'array_op', col, op: '@>', val }) }
  containedBy(col: string, val: unknown): this { return this._w({ k: 'array_op', col, op: '<@', val }) }
  overlaps(col: string, val: unknown): this { return this._w({ k: 'array_op', col, op: '&&', val }) }

  not(col: string, op: string, val: unknown): this {
    this._wheres.push({ k: 'simple', col, op: `NOT ${mapOp(op)}`, val })
    return this
  }

  or(filterStr: string): this { return this._w({ k: 'or', raw: filterStr }) }

  filter(col: string, op: string, val: unknown): this {
    return this._w({ k: 'simple', col, op: mapOp(op), val })
  }

  match(q: Record<string, unknown>): this {
    Object.entries(q).forEach(([k, v]) => this.eq(k, v)); return this
  }

  textSearch(col: string, query: string, opts?: { config?: string }): this {
    const cfg = opts?.config ? `'${opts.config.replace(/'/g, "''")}',` : ''
    this._wheres.push({ k: 'no_val', col, expr: `to_tsvector(${cfg}${ident(col)}) @@ plainto_tsquery(${cfg}$__PARAM__)`.replace('$__PARAM__', '__ph__') })
    // Simpler: just add a raw fragment; will be parameterised in _filterSql
    this._wheres.push({ k: 'simple', col: `to_tsvector(${cfg}${ident(col)})`, op: '@@', val: `plainto_tsquery('${query.replace(/'/g, "''")}')` })
    return this
  }

  // ---- modifiers ---------------------------------------------------------

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string }): this {
    this._orders.push({ col: opts?.foreignTable ? `${opts.foreignTable}.${col}` : col, asc: opts?.ascending !== false, nullsFirst: opts?.nullsFirst })
    return this
  }

  limit(n: number): this { this._limit = n; return this }

  range(from: number, to: number): this {
    this._offset = from; this._limit = to - from + 1; return this
  }

  single(): this { this._single = true; return this }
  maybeSingle(): this { this._maybeSingle = true; return this }
  throwOnError(): this { return this }

  // ---- returning (chained after insert/update/delete) --------------------
  // Supabase sometimes uses .select() after a mutation to get returning columns.
  // We intercept that here.

  // ---- thenable ----------------------------------------------------------

  then<R1 = PgResult<T>, R2 = never>(
    onFulfilled?: ((v: PgResult<T>) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this._run().then(onFulfilled, onRejected)
  }

  catch<R = never>(fn?: ((r: unknown) => R | PromiseLike<R>) | null): Promise<PgResult<T> | R> {
    return this._run().catch(fn)
  }

  finally(fn?: (() => void) | null): Promise<PgResult<T>> {
    return this._run().finally(fn)
  }

  // ---- private -----------------------------------------------------------

  private _w(f: WhereKind): this { this._wheres.push(f); return this }

  private async _run(): Promise<PgResult<T>> {
    try {
      const { query, params } = await this._build()
      let rows: Record<string, unknown>[]

      if (this._userId) {
        // Enforce RLS via SET LOCAL in a mini-transaction.
        const claims = JSON.stringify({ sub: this._userId, role: 'authenticated' })
        rows = await this._sql.begin(async tx => {
          await tx.unsafe(`SET LOCAL role = 'authenticated'`)
          await tx.unsafe(`SET LOCAL "request.jwt.claims" = '${claims.replace(/'/g, "''")}'`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return tx.unsafe<Record<string, unknown>[]>(query, params as any[])
        })
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rows = await this._sql.unsafe<Record<string, unknown>[]>(query, params as any[])
      }

      return this._shape(rows)
    } catch (err) {
      return {
        data: null,
        error: {
          message: err instanceof Error ? err.message : String(err),
          code: (err as { code?: string }).code,
        },
      }
    }
  }

  private _shape(rows: Record<string, unknown>[]): PgResult<T> {
    let count: number | null = null

    if (this._count === 'exact') {
      count = rows.length > 0 ? Number(rows[0]['_pg_count']) : 0
      rows = rows.map(({ _pg_count: _, ...rest }) => rest)
    }

    if (this._headOnly) return { data: null, error: null, count }

    if (this._single) {
      if (rows.length === 0) {
        return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } }
      }
      return { data: rows[0] as unknown as T, error: null, count }
    }

    if (this._maybeSingle) {
      return { data: rows.length > 0 ? rows[0] as unknown as T : null, error: null, count }
    }

    return { data: rows as unknown as T, error: null, count }
  }

  private async _build(): Promise<{ query: string; params: unknown[] }> {
    const params: unknown[] = []
    let p = 0
    const P = (v: unknown) => { params.push(v); return `$${++p}` }
    const tbl = `${ident(this._schema)}.${ident(this._table)}`

    switch (this._op) {
      case 'select': return this._buildSelect(tbl, P, params)
      case 'insert': return this._buildInsert(tbl, P, params)
      case 'update': return this._buildUpdate(tbl, P, params)
      case 'delete': return this._buildDelete(tbl, P, params)
      case 'upsert': return this._buildUpsert(tbl, P, params)
    }
  }

  private async _buildSelect(
    tbl: string,
    P: (v: unknown) => string,
    params: unknown[],
  ): Promise<{ query: string; params: unknown[] }> {
    const spec = parseSpec(this._selectRaw)
    const hasEmbedded = spec.columns.some(c => c.embedded)
    const alias = hasEmbedded ? '_t' : undefined

    // Direct columns
    const directCols = spec.columns
      .filter(c => !c.embedded)
      .map(c => colExpr(c.raw, alias))

    // Embedded-resource subqueries
    const embCols: string[] = []
    for (const c of spec.columns.filter(c => c.embedded)) {
      const sub = await this._embeddedSub(c.embedded!, alias ?? this._table, P)
      if (sub) embCols.push(`${sub} AS ${ident(c.embedded!.alias ?? c.embedded!.relation)}`)
    }

    const colList = [...directCols, ...embCols].join(', ') || '*'
    const countExtra = this._count === 'exact' ? `, COUNT(*) OVER() AS _pg_count` : ''
    const where = this._whereClause(P, alias)
    const order = this._orderClause(alias)
    const lim = this._limit !== null ? `LIMIT ${P(this._limit)}` : ''
    const off = this._offset != null && this._offset > 0 ? `OFFSET ${P(this._offset)}` : ''
    const from = alias ? `${tbl} ${alias}` : tbl

    const q = `SELECT ${colList}${countExtra} FROM ${from} ${where} ${order} ${lim} ${off}`.replace(/\s+/g, ' ').trim()
    return { query: q, params }
  }

  private async _embeddedSub(
    emb: EmbeddedSpec,
    mainAlias: string,
    P: (v: unknown) => string,
  ): Promise<string | null> {
    const embTbl = `${ident(this._schema)}.${ident(emb.relation)}`
    const ea = `_e_${emb.relation}`

    // Determine join columns
    let fkCol: string, refCol: string, oneToMany: boolean

    if (emb.hint) {
      // Explicit hint: could be FK column on either side. Heuristic:
      // if main table has hint column, many-to-one; else one-to-many.
      // We'll verify against information_schema in a follow-up; for now trust the hint.
      fkCol = emb.hint; refCol = 'id'; oneToMany = false
    } else {
      const fks = await lookupFk(this._sql, this._table, emb.relation)
      if (fks.length === 0) {
        console.warn(`[pg] no FK between ${this._table} and ${emb.relation}; skipping embed`)
        return null
      }
      const fk = fks[0]
      if (fk.fkTable === emb.relation) {
        oneToMany = true; fkCol = fk.fkColumn; refCol = fk.refColumn
      } else {
        oneToMany = false; fkCol = fk.fkColumn; refCol = fk.refColumn
      }
    }

    const subCols = emb.select.columns
      .filter(c => !c.embedded)
      .map(c => colExpr(c.raw, ea))
      .join(', ') || `${ea}.*`

    if (oneToMany) {
      const agg = emb.inner
        ? `(SELECT json_agg(${ea}_row) FROM (SELECT ${subCols} FROM ${embTbl} ${ea} WHERE ${ident(ea)}.${ident(fkCol)} = ${ident(mainAlias)}.${ident(refCol)}) ${ea}_row)`
        : `(SELECT COALESCE(json_agg(${ea}_row), '[]'::json) FROM (SELECT ${subCols} FROM ${embTbl} ${ea} WHERE ${ident(ea)}.${ident(fkCol)} = ${ident(mainAlias)}.${ident(refCol)}) ${ea}_row)`
      return agg
    } else {
      return `(SELECT row_to_json(${ea}_row) FROM (SELECT ${subCols} FROM ${embTbl} ${ea} WHERE ${ident(ea)}.${ident(refCol)} = ${ident(mainAlias)}.${ident(fkCol)} LIMIT 1) ${ea}_row)`
    }
  }

  private _buildInsert(tbl: string, P: (v: unknown) => string, params: unknown[]): { query: string; params: unknown[] } {
    const rows = this._insertVals!
    const cols = Object.keys(rows[0])
    const colList = cols.map(ident).join(', ')
    const valRows = rows.map(r => `(${cols.map(c => P(r[c])).join(', ')})`).join(', ')
    const returning = this._returning ?? this._selectRaw
    const ret = returning && returning !== '*' ? returning.split(',').map(c => ident(c.trim())).join(', ') : '*'
    return { query: `INSERT INTO ${tbl} (${colList}) VALUES ${valRows} RETURNING ${ret}`, params }
  }

  private _buildUpdate(tbl: string, P: (v: unknown) => string, params: unknown[]): { query: string; params: unknown[] } {
    const set = Object.entries(this._updateVals!).map(([c, v]) => `${ident(c)} = ${P(v)}`).join(', ')
    const where = this._whereClause(P)
    const ret = this._returning ?? this._selectRaw
    const retCols = ret && ret !== '*' ? ret.split(',').map(c => ident(c.trim())).join(', ') : '*'
    return { query: `UPDATE ${tbl} SET ${set} ${where} RETURNING ${retCols}`.replace(/\s+/g, ' ').trim(), params }
  }

  private _buildDelete(tbl: string, P: (v: unknown) => string, params: unknown[]): { query: string; params: unknown[] } {
    const where = this._whereClause(P)
    return { query: `DELETE FROM ${tbl} ${where}`.replace(/\s+/g, ' ').trim(), params }
  }

  private _buildUpsert(tbl: string, P: (v: unknown) => string, params: unknown[]): { query: string; params: unknown[] } {
    const rows = this._insertVals!
    const cols = Object.keys(rows[0])
    const colList = cols.map(ident).join(', ')
    const valRows = rows.map(r => `(${cols.map(c => P(r[c])).join(', ')})`).join(', ')
    const conflictTarget = this._conflictCols ? `(${this._conflictCols.map(ident).join(', ')})` : ''
    let onConflict: string
    if (this._ignoreDups) {
      onConflict = `ON CONFLICT ${conflictTarget} DO NOTHING`
    } else {
      const updateCols = this._conflictCols
        ? cols.filter(c => !this._conflictCols!.includes(c))
        : cols.filter(c => c !== 'id' && c !== 'created_at')
      const setClause = updateCols.map(c => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')
      onConflict = setClause
        ? `ON CONFLICT ${conflictTarget} DO UPDATE SET ${setClause}`
        : `ON CONFLICT ${conflictTarget} DO NOTHING`
    }
    return { query: `INSERT INTO ${tbl} (${colList}) VALUES ${valRows} ${onConflict} RETURNING *`, params }
  }

  private _whereClause(P: (v: unknown) => string, tableAlias?: string): string {
    const parts = this._wheres.map(f => this._filterSql(f, P, tableAlias)).filter(Boolean)
    return parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : ''
  }

  private _filterSql(f: WhereKind, P: (v: unknown) => string, tableAlias?: string): string {
    const col = (name: string) => {
      // Don't quote if the column already contains SQL operators
      if (name.includes('(') || name.includes('.') || name.includes('-')) return name
      return tableAlias ? `${ident(tableAlias)}.${ident(name)}` : ident(name)
    }
    switch (f.k) {
      case 'simple':
        if (f.op.startsWith('NOT ')) {
          return `NOT (${col(f.col)} ${f.op.slice(4)} ${P(f.val)})`
        }
        return `${col(f.col)} ${f.op} ${P(f.val)}`
      case 'no_val':
        if (tableAlias) return f.expr.replace(ident(f.col), `${ident(tableAlias)}.${ident(f.col)}`)
        return f.expr
      case 'in':
        if (f.vals.length === 0) return 'FALSE'
        return `${col(f.col)} IN (${f.vals.map(v => P(v)).join(', ')})`
      case 'array_op':
        return `${col(f.col)} ${f.op} ${P(f.val)}`
      case 'or':
        return `(${parseOrStr(f.raw, P)})`
    }
  }

  private _orderClause(tableAlias?: string): string {
    if (this._orders.length === 0) return ''
    const terms = this._orders.map(o => {
      const col = tableAlias ? `${ident(tableAlias)}.${ident(o.col)}` : ident(o.col)
      const dir = o.asc ? 'ASC' : 'DESC'
      const nulls = o.nullsFirst === true ? ' NULLS FIRST' : o.nullsFirst === false ? ' NULLS LAST' : ''
      return `${col} ${dir}${nulls}`
    })
    return `ORDER BY ${terms.join(', ')}`
  }
}
