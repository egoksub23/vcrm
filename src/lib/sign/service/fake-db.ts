// A small in-memory stand-in for the Supabase client, for testing how the Doc Sign services orchestrate
// their calls: tables as arrays of rows, the query builder methods the services use, RPCs answered by
// handlers the test supplies, and storage as a map. It does not run SQL; the database functions are
// proved by supabase/ci/verify-157 and verify-158. Imported only by tests.

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; details?: string } | null; count?: number };
type Filter = (r: Row) => boolean;

/** What the database fills in for a column that is NOT NULL DEFAULT: a row seeded or inserted without it has it (migration 176: nothing is private unless it says so). */
const COLUMN_DEFAULTS: Record<string, Row> = {
  sign_documents: { is_private: false },
  sign_envelopes: { is_private: false },
};

/** Split a PostgREST `or(...)` list at its top-level commas (a comma inside `in.(a,b)` stays). */
function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of expr) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** One `column.operator.value` of an `or(...)`: eq, neq, is, in, gt, gte, lt, lte. */
function orCondition(part: string): Filter {
  const first = part.indexOf(".");
  const second = part.indexOf(".", first + 1);
  const col = part.slice(0, first);
  const op = part.slice(first + 1, second);
  const value = part.slice(second + 1);
  const text = (r: Row) => (r[col] === null || r[col] === undefined ? null : String(r[col]));
  switch (op) {
    case "eq":
      return (r) => text(r) === value;
    case "neq":
      return (r) => text(r) !== value;
    case "is":
      return (r) => (value === "null" ? text(r) === null : text(r) === value);
    case "in": {
      const set = new Set(splitTopLevel(value.replace(/^\(/, "").replace(/\)$/, "")));
      return (r) => text(r) !== null && set.has(text(r) as string);
    }
    case "gt":
      return (r) => text(r) !== null && (text(r) as string) > value;
    case "gte":
      return (r) => text(r) !== null && (text(r) as string) >= value;
    case "lt":
      return (r) => text(r) !== null && (text(r) as string) < value;
    case "lte":
      return (r) => text(r) !== null && (text(r) as string) <= value;
    default:
      throw new Error(`FakeDb: or() does not know the operator "${op}"`);
  }
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  files = new Map<string, Uint8Array>();
  rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  rpcHandlers: Record<string, (args: Record<string, unknown>) => Result | Promise<Result>> = {};
  /** Make a table's next write fail. */
  failNext: Record<string, string> = {};
  /** What the database fills in for a table's new row (its column defaults and triggers): merged under what the insert gives. */
  insertDefaults: Record<string, (given: Row) => Row> = {};

  seed(table: string, rows: Row[]): this {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((r) => ({ ...(COLUMN_DEFAULTS[table] ?? {}), ...r }))];
    return this;
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }

  client(): SupabaseClient {
    return {
      from: (t: string) => new Query(this, t),
      rpc: async (name: string, args: Record<string, unknown> = {}) => {
        this.rpcCalls.push({ name, args });
        const h = this.rpcHandlers[name];
        if (!h) return { data: null, error: { message: `no handler for rpc ${name}` } };
        return h(args);
      },
      storage: {
        from: () => ({
          upload: async (path: string, bytes: Uint8Array) => {
            if (this.files.has(path)) return { data: null, error: { message: "The resource already exists" } };
            this.files.set(path, new Uint8Array(bytes));
            return { data: { path }, error: null };
          },
          download: async (path: string) => {
            const b = this.files.get(path);
            if (!b) return { data: null, error: { message: "Object not found" } };
            return { data: new Blob([b as BlobPart]), error: null };
          },
          copy: async (from: string, to: string) => {
            const b = this.files.get(from);
            if (!b) return { data: null, error: { message: "Object not found" } };
            this.files.set(to, new Uint8Array(b));
            return { data: { path: to }, error: null };
          },
          remove: async (paths: string[]) => {
            for (const p of paths) this.files.delete(p);
            return { data: [], error: null };
          },
        }),
      },
    } as unknown as SupabaseClient;
  }
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: Row | Row[] | null = null;
  private filters: Filter[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private max: number | null = null;
  private from = 0;
  private wantRows = false;
  /** select(cols, { count: "exact", head: true }): the number of matching rows, and no rows when `head`. */
  private counting = false;
  private headOnly = false;
  private mode: "single" | "maybe" | null = null;
  private conflict: string[] = [];
  private ignoreDuplicates = false;

  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string, opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }): this {
    this.counting = !!opts?.count;
    this.headOnly = !!opts?.head;
    if (this.op !== "select") this.wantRows = true;
    return this;
  }
  insert(p: Row | Row[]): this {
    this.op = "insert";
    this.payload = p;
    return this;
  }
  upsert(p: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.op = "upsert";
    this.payload = p;
    this.conflict = (opts?.onConflict ?? "id").split(",").map((s) => s.trim());
    this.ignoreDuplicates = !!opts?.ignoreDuplicates;
    return this;
  }
  update(p: Row): this {
    this.op = "update";
    this.payload = p;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(col: string, v: unknown): this {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  neq(col: string, v: unknown): this {
    this.filters.push((r) => r[col] !== v);
    return this;
  }
  in(col: string, vs: unknown[]): this {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  is(col: string, v: unknown): this {
    this.filters.push((r) => (v === null ? r[col] === null || r[col] === undefined : r[col] === v));
    return this;
  }
  gte(col: string, v: unknown): this {
    this.filters.push((r) => r[col] != null && String(r[col]) >= String(v));
    return this;
  }
  gt(col: string, v: unknown): this {
    this.filters.push((r) => r[col] != null && String(r[col]) > String(v));
    return this;
  }
  lte(col: string, v: unknown): this {
    this.filters.push((r) => r[col] != null && String(r[col]) <= String(v));
    return this;
  }
  lt(col: string, v: unknown): this {
    this.filters.push((r) => r[col] != null && String(r[col]) < String(v));
    return this;
  }
  /** LIKE with % and _ (a backslash escapes either); `ilike` ignores case. */
  like(col: string, pattern: string): this {
    return this.pattern(col, pattern, false);
  }
  ilike(col: string, pattern: string): this {
    return this.pattern(col, pattern, true);
  }
  private pattern(col: string, pattern: string, ignoreCase: boolean): this {
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "\\" && i + 1 < pattern.length) source += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      else if (c === "%") source += ".*";
      else if (c === "_") source += ".";
      else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    const re = new RegExp(`^${source}$`, ignoreCase ? "is" : "s");
    this.filters.push((r) => typeof r[col] === "string" && re.test(r[col] as string));
    return this;
  }
  /** PostgREST's `or(a.eq.1,b.is.null,id.in.(x,y))`: a row passes when any of the conditions holds (several calls are ANDed, as the database does). */
  or(expr: string): this {
    const tests = splitTopLevel(expr).map(orCondition);
    this.filters.push((r) => tests.some((t) => t(r)));
    return this;
  }
  not(col: string, _op: string, v: unknown): this {
    this.filters.push((r) => (v === null ? r[col] !== null && r[col] !== undefined : r[col] !== v));
    return this;
  }
  order(col: string, o?: { ascending?: boolean }): this {
    this.orders.push({ col, asc: o?.ascending !== false });
    return this;
  }
  limit(n: number): this {
    this.max = n;
    return this;
  }
  /** PostgREST's inclusive row range, after the ordering. */
  range(from: number, to: number): this {
    this.from = from;
    this.max = to - from + 1;
    return this;
  }
  single(): this {
    this.mode = "single";
    return this;
  }
  maybeSingle(): this {
    this.mode = "maybe";
    return this;
  }

  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, bad);
  }

  private fail(message: string): Result {
    return { data: null, error: { message } };
  }

  private run(): Result {
    const rows = (this.db.tables[this.table] ??= []);
    const injected = this.db.failNext[this.table];
    if (injected && this.op !== "select") {
      delete this.db.failNext[this.table];
      return this.fail(injected);
    }
    const match = (r: Row) => this.filters.every((f) => f(r));
    let out: Row[] = [];
    const now = new Date().toISOString();

    if (this.op === "select") {
      out = rows.filter(match);
    } else if (this.op === "insert" || this.op === "upsert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      for (const p of list) {
        const row: Row = { id: randomUUID(), created_at: now, updated_at: now, ...(COLUMN_DEFAULTS[this.table] ?? {}), ...(this.db.insertDefaults[this.table]?.(p) ?? {}), ...p };
        if (this.op === "upsert") {
          const existing = rows.find((r) => this.conflict.every((c) => r[c] === row[c]));
          if (existing && this.ignoreDuplicates) continue;
          if (existing) {
            Object.assign(existing, p, { updated_at: now });
            out.push(existing);
            continue;
          }
        }
        rows.push(row);
        out.push(row);
      }
    } else if (this.op === "update") {
      for (const r of rows.filter(match)) {
        Object.assign(r, this.payload, { updated_at: now });
        out.push(r);
      }
    } else if (this.op === "delete") {
      const gone = rows.filter(match);
      this.db.tables[this.table] = rows.filter((r) => !gone.includes(r));
      out = gone;
    }

    for (const { col, asc } of [...this.orders].reverse()) {
      out = [...out].sort((a, b) => (typeof a[col] === "number" && typeof b[col] === "number" ? (a[col] as number) - (b[col] as number) : String(a[col] ?? "").localeCompare(String(b[col] ?? ""))) * (asc ? 1 : -1));
    }
    const total = out.length;
    if (this.max !== null) out = out.slice(this.from, this.from + this.max);
    out = out.map((r) => ({ ...r }));
    if (this.counting) return { data: this.headOnly ? null : out, error: null, count: total };

    const returnsRows = this.op === "select" || this.wantRows;
    if (this.mode === "single") {
      if (out.length !== 1) return this.fail(out.length === 0 ? "no rows" : "multiple rows");
      return { data: out[0], error: null };
    }
    if (this.mode === "maybe") {
      if (out.length > 1) return this.fail("multiple rows");
      return { data: out[0] ?? null, error: null };
    }
    return { data: returnsRows ? out : null, error: null };
  }
}
