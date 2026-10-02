import { describe, expect, it, vi } from "vitest";

import { eq, onScopedChanges } from "./scoped-changes";

function fakeChannel() {
  const calls: { type: string; config: Record<string, unknown> }[] = [];
  const channel = {
    on: vi.fn((type: string, config: Record<string, unknown>) => {
      calls.push({ type, config });
      return channel;
    }),
  };
  return { channel: channel as never, calls };
}

describe("onScopedChanges", () => {
  it("filters inserts and updates by the workspace and leaves deletes unfiltered", () => {
    const { channel, calls } = fakeChannel();
    onScopedChanges(channel, { table: "messages", filter: eq("account_id", "acct-1") }, () => {});
    expect(calls.map((c) => c.config)).toEqual([
      { event: "INSERT", schema: "public", table: "messages", filter: "account_id=eq.acct-1" },
      { event: "UPDATE", schema: "public", table: "messages", filter: "account_id=eq.acct-1" },
      { event: "DELETE", schema: "public", table: "messages" },
    ]);
  });

  it("subscribes only the requested events", () => {
    const { channel, calls } = fakeChannel();
    onScopedChanges(channel, { table: "tickets", filter: eq("account_id", "a"), events: ["INSERT"] }, () => {});
    expect(calls).toHaveLength(1);
    expect(calls[0].config.event).toBe("INSERT");
  });

  it("never puts a filter on a DELETE subscription (it would silence deletes)", () => {
    const { channel, calls } = fakeChannel();
    onScopedChanges(channel, { table: "t", filter: "account_id=eq.x" }, () => {});
    const del = calls.find((c) => c.config.event === "DELETE")!;
    expect("filter" in del.config).toBe(false);
  });

  it("returns the channel so calls chain", () => {
    const { channel } = fakeChannel();
    expect(onScopedChanges(channel, { table: "t", filter: "a=eq.b" }, () => {})).toBe(channel);
  });
});
