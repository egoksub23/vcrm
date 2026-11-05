/* @deprecated — use useAccountSse from @/hooks/use-account-sse instead.
 * This file remains only for tests that still reference ChangePayload/ChangeEvent. */

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChangePayload = {
  eventType: ChangeEvent;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
};

/** The filter string for "this workspace's rows" (or any equality filter). */
export function eq(column: string, value: string): string {
  return `${column}=eq.${value}`;
}

/** No-op shim kept for test compilation. Real realtime uses useAccountSse. */
export function onScopedChanges(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  channel: any,
  _spec: { table: string; filter: string; events?: readonly ChangeEvent[] },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _handler: (payload: ChangePayload) => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return channel;
}
