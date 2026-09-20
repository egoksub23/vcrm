import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RECENT_KEY,
  RECENT_MAX,
  TONE_KEY,
  pushRecent,
  readRecent,
  readTone,
  resetEmojiStorageForTests,
  writeTone,
} from "./storage";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function stubWindow(storage: unknown) {
  vi.stubGlobal("window", { localStorage: storage });
}

describe("frequently used emoji", () => {
  beforeEach(() => resetEmojiStorageForTests());
  afterEach(() => vi.unstubAllGlobals());

  it("puts the latest first, moves repeats up, and caps the list", () => {
    const store = memoryStorage();
    stubWindow(store);
    expect(readRecent()).toEqual([]);
    pushRecent("😀");
    pushRecent("👍");
    expect(pushRecent("😀")).toEqual(["😀", "👍"]);
    for (let i = 0; i < RECENT_MAX + 5; i++) pushRecent(String.fromCodePoint(0x1f600 + i));
    const list = readRecent();
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]).toBe(String.fromCodePoint(0x1f600 + RECENT_MAX + 4));
    expect(JSON.parse(store.map.get(RECENT_KEY)!)).toEqual(list);
  });

  it("uses a versioned storage key", () => {
    expect(RECENT_KEY).toMatch(/\.v1$/);
    expect(TONE_KEY).toMatch(/\.v1$/);
  });

  it("still works when localStorage throws on every call", () => {
    const boom = () => {
      throw new Error("SecurityError");
    };
    stubWindow({ getItem: boom, setItem: boom });
    expect(readRecent()).toEqual([]);
    expect(() => pushRecent("😀")).not.toThrow();
    // Kept in memory for the rest of the page's life.
    expect(pushRecent("👍")).toEqual(["👍", "😀"]);
    expect(readRecent()).toEqual(["👍", "😀"]);
    expect(readTone()).toBe(0);
    expect(() => writeTone(3)).not.toThrow();
    expect(readTone()).toBe(3);
  });

  it("still works when the localStorage accessor itself throws", () => {
    vi.stubGlobal("window", {
      get localStorage(): never {
        throw new Error("blocked");
      },
    });
    expect(readRecent()).toEqual([]);
    expect(pushRecent("😀")).toEqual(["😀"]);
  });

  it("still works with no window at all (server render)", () => {
    vi.stubGlobal("window", undefined);
    expect(readRecent()).toEqual([]);
    expect(pushRecent("😀")).toEqual(["😀"]);
    expect(readTone()).toBe(0);
  });

  it("ignores corrupt stored data", () => {
    stubWindow(memoryStorage({ [RECENT_KEY]: "{not json", [TONE_KEY]: "banana" }));
    expect(readRecent()).toEqual([]);
    expect(readTone()).toBe(0);
    stubWindow(memoryStorage({ [RECENT_KEY]: JSON.stringify([1, "😀", null, ""]), [TONE_KEY]: "9" }));
    expect(readRecent()).toEqual(["😀"]);
    expect(readTone()).toBe(0);
  });

  it("remembers the skin tone", () => {
    const store = memoryStorage();
    stubWindow(store);
    writeTone(4);
    expect(store.map.get(TONE_KEY)).toBe("4");
    expect(readTone()).toBe(4);
  });
});
