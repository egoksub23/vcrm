// ============================================================
// Compliance requests: the event trail (compliance_request_events, migration 183). Server only. The service role writes; the table is append-only.
//
// A detail is built from named, small, plain values (ids, field names, statuses, the note the person typed): never an object of answers, never a
// ciphertext, never a bank detail. `safeDetail` enforces the shape so a caller cannot slip a secret in by passing a bigger object.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventKind } from "../types";

export type DetailValue = string | number | boolean | null | string[];
export type EventDetail = Record<string, DetailValue>;

const MAX_VALUE = 2000;

export function safeDetail(d: EventDetail | undefined): Record<string, DetailValue> {
  const out: Record<string, DetailValue> = {};
  for (const [k, v] of Object.entries(d ?? {})) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, MAX_VALUE);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 80));
  }
  return out;
}

export interface LogEventInput {
  accountId: string;
  requestId: string;
  actor: string | null;
  kind: EventKind;
  detail?: EventDetail;
}

/** Write one event. False when it could not be written (the caller then refuses to show or do what the event records: the trail is never skipped). */
export async function logEvent(admin: SupabaseClient, input: LogEventInput): Promise<boolean> {
  try {
    const { error } = await admin.from("compliance_request_events").insert({
      account_id: input.accountId,
      request_id: input.requestId,
      actor: input.actor,
      kind: input.kind,
      detail: safeDetail(input.detail),
    });
    if (error) {
      console.error("[compliance] event write failed");
      return false;
    }
    return true;
  } catch {
    console.error("[compliance] event write failed");
    return false;
  }
}
