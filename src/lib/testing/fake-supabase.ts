import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Test helper: a chainable stand-in for the Supabase client. It records every
 * query (table, operation, payload, filters) and answers each with what the
 * per-table handler returns, so a route's rules can be tested without a
 * database. `.select()`, `.eq()`, `.in()`, `.order()` ... only record; the
 * query runs when it is awaited or ends in `.single()` / `.maybeSingle()`.
 */
export interface FakeCall {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  options?: unknown;
  filters: { kind: string; column?: string; value?: unknown }[];
  single: boolean;
}

export interface FakeResult {
  data: unknown;
  error: unknown;
  count?: number | null;
}

export type FakeHandler = (call: FakeCall) => FakeResult | Promise<FakeResult>;

export function fakeSupabase(handlers: Record<string, FakeHandler>) {
  const calls: FakeCall[] = [];

  const client = {
    from(table: string) {
      const call: FakeCall = { table, op: "select", filters: [], single: false };
      let opSet = false;
      const run = async (): Promise<FakeResult> => {
        calls.push(call);
        const handler = handlers[table];
        if (!handler) return { data: null, error: { message: `no handler for ${table}` } };
        const res = await handler(call);
        if (call.single && Array.isArray(res.data)) return { ...res, data: res.data[0] ?? null };
        return res;
      };
      const chain: Record<string, unknown> = {
        select() {
          if (!opSet) call.op = "select";
          return chain;
        },
        insert(payload: unknown) {
          call.op = "insert";
          call.payload = payload;
          opSet = true;
          return chain;
        },
        update(payload: unknown) {
          call.op = "update";
          call.payload = payload;
          opSet = true;
          return chain;
        },
        upsert(payload: unknown, options?: unknown) {
          call.op = "upsert";
          call.payload = payload;
          call.options = options;
          opSet = true;
          return chain;
        },
        delete() {
          call.op = "delete";
          opSet = true;
          return chain;
        },
        eq(column: string, value: unknown) {
          call.filters.push({ kind: "eq", column, value });
          return chain;
        },
        in(column: string, value: unknown) {
          call.filters.push({ kind: "in", column, value });
          return chain;
        },
        or(value: string) {
          call.filters.push({ kind: "or", value });
          return chain;
        },
        order() {
          return chain;
        },
        limit() {
          return chain;
        },
        single() {
          call.single = true;
          return run();
        },
        maybeSingle() {
          call.single = true;
          return run();
        },
        then(resolve: (v: FakeResult) => unknown, reject?: (e: unknown) => unknown) {
          return run().then(resolve, reject);
        },
      };
      return chain;
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

export const ok = (data: unknown): FakeResult => ({ data, error: null });
export const fail = (message = "boom", code?: string): FakeResult => ({ data: null, error: { message, code } });
