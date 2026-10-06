// A small in-memory stand-in for the Supabase client, for testing how the Doc Sign services orchestrate
// their calls: tables as arrays of rows, the query builder methods the services use, RPCs answered by
// handlers the test supplies, and storage as a map. It does not run SQL; the database functions are
// proved by supabase/ci/verify-157 and verify-158. Imported only by tests.

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; details?: string } | null };
type Filter = (r: Row) => boolean;

export class FakeDb {
  tables: Record<string, Row[]> = {};
  files = new Map<string, Uint8Array>();
  rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  rpcHandlers: Record<string, (args: Record<string, unknown>) => Result | Promise<Result>> = {};
  /** Make a table's next write fail. */
  failNext: Record<string, string> = {};

  seed(table: string, rows: Row[]): this {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((r) => ({ ...r }))];
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
  private wantRows = false;
  private mode: "single" | "maybe" | null = null;
  private conflict: string[] = [];

  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string): this {
    if (this.op !== "select") this.wantRows = true;
    return this;
  }
  insert(p: Row | Row[]): this {
    this.op = "insert";
    this.payload = p;
    return this;
  }
  upsert(p: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = "upsert";
    this.payload = p;
    this.conflict = (opts?.onConflict ?? "id").split(",").map((s) => s.trim());
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
        const row: Row = { id: randomUUID(), created_at: now, updated_at: now, ...p };
        if (this.op === "upsert") {
          const existing = rows.find((r) => this.conflict.every((c) => r[c] === row[c]));
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
      out = [...out].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (asc ? 1 : -1));
    }
    if (this.max !== null) out = out.slice(0, this.max);
    out = out.map((r) => ({ ...r }));

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
