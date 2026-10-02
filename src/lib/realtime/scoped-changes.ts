import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";

// ============================================================
// Live updates scoped to one workspace.
//
// A `postgres_changes` subscription with no filter receives every change to the
// table, from every customer, and the server checks row security for each
// subscriber on each change. Filtering by the workspace column makes the server
// consider only that workspace's changes.
//
// DELETE events cannot be filtered by a column (the deleted row's old values
// carry only its primary key), so a filter on them would silence them. Deletes
// are therefore subscribed separately and unfiltered: they carry only an id, and
// handlers match that id against what they already hold, so another workspace's
// delete is ignored.
// ============================================================

export type ChangeEvent = "INSERT" | "UPDATE" | "DELETE";
// Same loose row type supabase-js uses by default, so handlers can cast `payload.new` as before.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChangePayload = RealtimePostgresChangesPayload<{ [key: string]: any }>;

/** The filter string for "this workspace's rows" (or any equality filter). */
export function eq(column: string, value: string): string {
  return `${column}=eq.${value}`;
}

/**
 * Subscribe `handler` to a table's changes, filtered by `filter`, with deletes
 * delivered unfiltered (see above). `events` limits which kinds are subscribed.
 */
export function onScopedChanges(
  channel: RealtimeChannel,
  spec: { table: string; filter: string; events?: readonly ChangeEvent[] },
  handler: (payload: ChangePayload) => void,
): RealtimeChannel {
  const events = spec.events ?? (["INSERT", "UPDATE", "DELETE"] as const);
  const { table, filter } = spec;
  if (events.includes("INSERT")) {
    channel.on("postgres_changes", { event: "INSERT", schema: "public", table, filter }, handler);
  }
  if (events.includes("UPDATE")) {
    channel.on("postgres_changes", { event: "UPDATE", schema: "public", table, filter }, handler);
  }
  if (events.includes("DELETE")) {
    channel.on("postgres_changes", { event: "DELETE", schema: "public", table }, handler);
  }
  return channel;
}
