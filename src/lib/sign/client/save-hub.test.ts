import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SaveHub } from "./save-hub";
import type { SaveState } from "./save-queue";

const failure = (status: number) => Object.assign(new Error("x"), { status, code: "request_failed" });

function setup(over: { layout?: (id: string, v: string) => Promise<unknown>; values?: (id: string, v: string) => Promise<unknown> } = {}) {
  const sentLayout: [string, string][] = [];
  const sentValues: [string, string][] = [];
  const states: Record<string, SaveState[]> = {};
  const hub = new SaveHub<string, string>({
    sendLayout: async (id, v) => {
      sentLayout.push([id, v]);
      return over.layout?.(id, v);
    },
    sendValues: async (id, v) => {
      sentValues.push([id, v]);
      return over.values?.(id, v);
    },
    onState: (id, s) => (states[id] ??= []).push(s),
  });
  return { hub, sentLayout, sentValues, states };
}

describe("SaveHub: several documents saving to their own documents", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("routes each document's change to that document only, coalescing the changes of one document", async () => {
    const { hub, sentLayout } = setup();
    hub.scheduleLayout("d1", "a");
    hub.scheduleLayout("d2", "x");
    hub.scheduleLayout("d1", "b");
    await vi.advanceTimersByTimeAsync(900);
    expect([...sentLayout].sort()).toEqual([
      ["d1", "b"],
      ["d2", "x"],
    ]);
  });

  it("keeps the merge values of a document apart from its blocks", async () => {
    const { hub, sentLayout, sentValues } = setup();
    hub.scheduleValues("d1", "v");
    hub.scheduleLayout("d1", "l");
    await vi.advanceTimersByTimeAsync(900);
    expect(sentValues).toEqual([["d1", "v"]]);
    expect(sentLayout).toEqual([["d1", "l"]]);
  });

  it("flushes every document at once when the step is left, and says all was saved", async () => {
    const { hub, sentLayout } = setup();
    hub.scheduleLayout("d1", "a");
    hub.scheduleLayout("d2", "b");
    hub.scheduleLayout("d3", "c");
    expect(hub.unsavedDocs().sort()).toEqual(["d1", "d2", "d3"]);
    const ok = await hub.flush();
    expect(ok).toBe(true);
    expect(sentLayout.map(([id]) => id).sort()).toEqual(["d1", "d2", "d3"]);
    expect(hub.unsavedDocs()).toEqual([]);
  });

  it("reports that something is left when one document cannot be saved, and keeps its value", async () => {
    const { hub } = setup({
      layout: async (id) => {
        if (id === "d2") throw failure(400);
      },
    });
    hub.scheduleLayout("d1", "a");
    hub.scheduleLayout("d2", "b");
    expect(await hub.flush()).toBe(false);
    expect(hub.unsavedDocs()).toEqual(["d2"]);
    expect(hub.stateOf("d2").kind).toBe("error");
    expect(hub.stateOf("d1").kind).toBe("saved");
    expect(hub.combined().kind).toBe("error");
  });

  it("can flush one document alone", async () => {
    const { hub, sentLayout } = setup();
    hub.scheduleLayout("d1", "a");
    hub.scheduleLayout("d2", "b");
    expect(await hub.flush("d1")).toBe(true);
    expect(sentLayout).toEqual([["d1", "a"]]);
    expect(hub.unsavedDocs()).toEqual(["d2"]);
  });

  it("combines the states: a problem beats saving beats waiting beats saved", async () => {
    const { hub } = setup();
    expect(hub.combined().kind).toBe("idle");
    hub.scheduleLayout("d1", "a");
    expect(hub.combined().kind).toBe("dirty");
    await hub.flush();
    expect(hub.combined().kind).toBe("saved");
  });

  it("forgets what waits for a document whose blocks the server would refuse", async () => {
    const { hub, sentLayout } = setup();
    hub.scheduleLayout("d1", "bad");
    hub.cancelLayout("d1");
    await vi.advanceTimersByTimeAsync(2000);
    expect(sentLayout).toEqual([]);
    expect(hub.stateOf("d1").kind).toBe("idle");
  });

  it("still sends what waits when the screen is left, for every document", async () => {
    const { hub, sentLayout } = setup();
    hub.scheduleLayout("d1", "a");
    hub.scheduleLayout("d2", "b");
    hub.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(sentLayout.map(([id]) => id).sort()).toEqual(["d1", "d2"]);
    hub.scheduleLayout("d3", "late");
    await vi.advanceTimersByTimeAsync(2000);
    expect(sentLayout).toHaveLength(2);
  });
});
