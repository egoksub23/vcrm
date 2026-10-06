import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SaveQueue, combineSaveStates, defaultCodeOf, defaultIsRetryable, type SaveState } from "./save-queue";

const failure = (status: number, code = "request_failed") => Object.assign(new Error(code), { status, code });

function setup(send: (v: string) => Promise<unknown>) {
  const states: SaveState[] = [];
  const queue = new SaveQueue<string>({ send, onState: (s) => states.push(s) });
  return { queue, states, kinds: () => states.map((s) => s.kind) };
}

describe("SaveQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a pause, then sends only the newest value", async () => {
    const send = vi.fn(async () => {});
    const { queue, kinds } = setup(send);
    queue.schedule("a");
    await vi.advanceTimersByTimeAsync(500);
    queue.schedule("b");
    await vi.advanceTimersByTimeAsync(500);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("b");
    expect(kinds()).toEqual(["dirty", "dirty", "saving", "saved"]);
    expect(queue.unsaved).toBe(false);
  });

  it("sends a change made during a send right after it", async () => {
    let release: () => void = () => {};
    const send = vi.fn((v: string) => (v === "a" ? new Promise<void>((r) => (release = r)) : Promise.resolve()));
    const { queue, kinds } = setup(send);
    queue.schedule("a");
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1);
    queue.schedule("b");
    expect(queue.unsaved).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("b");
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(kinds().at(-1)).toBe("saved");
  });

  it("never sends two at once", async () => {
    let running = 0;
    let max = 0;
    const send = vi.fn(async () => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 1000));
      running--;
    });
    const { queue } = setup(send);
    queue.schedule("a");
    await vi.advanceTimersByTimeAsync(800);
    queue.schedule("b");
    await vi.advanceTimersByTimeAsync(900);
    await vi.advanceTimersByTimeAsync(5000);
    expect(max).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps the value after a failure and retries after 3, 8 and 20 seconds", async () => {
    const send = vi.fn(async () => {
      throw failure(0, "network");
    });
    const { queue, states } = setup(send);
    queue.schedule("a");
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({ kind: "error", code: "network", willRetry: true });
    expect(queue.unsaved).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8000);
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20000);
    expect(send).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(20000);
    expect(send).toHaveBeenCalledTimes(5);
    expect(send).toHaveBeenLastCalledWith("a");
  });

  it("recovers: the retry that works ends in saved", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      if (++calls === 1) throw failure(503);
    });
    const { queue, kinds } = setup(send);
    queue.schedule("a");
    await vi.advanceTimersByTimeAsync(800);
    await vi.advanceTimersByTimeAsync(3000);
    expect(kinds()).toEqual(["dirty", "saving", "error", "saving", "saved"]);
    expect(queue.unsaved).toBe(false);
  });

  it("does not retry what will not pass, but keeps the value for a manual retry or the next change", async () => {
    let ok = false;
    const send = vi.fn(async () => {
      if (!ok) throw failure(400, "invalid_layout");
    });
    const { queue, states } = setup(send);
    queue.schedule("a");
    await vi.advanceTimersByTimeAsync(800);
    expect(states.at(-1)).toEqual({ kind: "error", code: "invalid_layout", willRetry: false });
    await vi.advanceTimersByTimeAsync(60000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.unsaved).toBe(true);
    ok = true;
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("a");
    expect(states.at(-1)).toEqual({ kind: "saved" });
  });

  it("a newer value replaces the one that failed", async () => {
    let n = 0;
    const send = vi.fn(async () => {
      if (++n === 1) throw failure(0, "network");
    });
    const { queue } = setup(send);
    queue.schedule("a");
    await vi.advanceTimersByTimeAsync(800);
    queue.schedule("b");
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenLastCalledWith("b");
    expect(queue.unsaved).toBe(false);
  });

  it("flush sends at once and cancel forgets the waiting value", async () => {
    const send = vi.fn(async () => {});
    const { queue } = setup(send);
    queue.schedule("a");
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
    queue.schedule("b");
    queue.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.unsaved).toBe(false);
  });

  it("stops after dispose", async () => {
    const send = vi.fn(async () => {});
    const { queue } = setup(send);
    queue.schedule("a");
    queue.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();
    queue.schedule("b");
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("leaving the screen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("still sends the waiting value once", async () => {
    const send = vi.fn(async () => {});
    const { queue } = setup(send);
    queue.schedule("a");
    queue.disposeAndSend();
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("a");
  });
  it("sends nothing when nothing is waiting, and survives a failing send", async () => {
    const send = vi.fn(async () => {
      throw failure(0, "network");
    });
    const idle = setup(send);
    idle.queue.disposeAndSend();
    expect(send).not.toHaveBeenCalled();
    const waiting = setup(send);
    waiting.queue.schedule("a");
    expect(() => waiting.queue.disposeAndSend()).not.toThrow();
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("combineSaveStates", () => {
  it("shows the most urgent state", () => {
    const err: SaveState = { kind: "error", code: "network", willRetry: true };
    expect(combineSaveStates([{ kind: "saved" }, err, { kind: "saving" }])).toBe(err);
    expect(combineSaveStates([{ kind: "saved" }, { kind: "saving" }, { kind: "dirty" }]).kind).toBe("saving");
    expect(combineSaveStates([{ kind: "idle" }, { kind: "dirty" }]).kind).toBe("dirty");
    expect(combineSaveStates([{ kind: "idle" }, { kind: "saved" }]).kind).toBe("saved");
    expect(combineSaveStates([]).kind).toBe("idle");
  });
});

describe("failure shapes", () => {
  it("retries only what can pass", () => {
    expect(defaultIsRetryable(failure(0, "network"))).toBe(true);
    expect(defaultIsRetryable(failure(500))).toBe(true);
    expect(defaultIsRetryable(failure(429))).toBe(true);
    expect(defaultIsRetryable(failure(400, "invalid_layout"))).toBe(false);
    expect(defaultIsRetryable(failure(409, "document_not_draft"))).toBe(false);
    expect(defaultIsRetryable(failure(403, "forbidden"))).toBe(false);
    expect(defaultIsRetryable(new Error("plain"))).toBe(true);
  });
  it("reads the code", () => {
    expect(defaultCodeOf(failure(400, "invalid_layout"))).toBe("invalid_layout");
    expect(defaultCodeOf("odd")).toBe("request_failed");
  });
});
