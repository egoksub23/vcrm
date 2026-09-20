import { describe, expect, it } from "vitest";

import { emojiForTone, normaliseQuery, searchEmoji } from "./search";
import { sampleData } from "./test-fixtures";

describe("searchEmoji", () => {
  const data = sampleData();
  const names = (q: string, limit?: number) => searchEmoji(data, q, limit).map((e) => e.name);

  it("is empty for an empty or colon-only query", () => {
    expect(names("")).toEqual([]);
    expect(names("   ")).toEqual([]);
    expect(names("::")).toEqual([]);
  });

  it("is case-insensitive and ignores the colons a user typed", () => {
    expect(names("PIZZA")).toEqual(["pizza"]);
    expect(names(":pizza:")).toEqual(["pizza"]);
    expect(names(":piz")).toEqual(["pizza"]);
  });

  it("matches names, keywords and shortcodes", () => {
    expect(names("korea")).toEqual(["flag: south korea"]);
    expect(names("cheese")).toEqual(["pizza"]);
    expect(names("thumbsup")).toEqual(["thumbs up"]);
    expect(names("+1")).toEqual(["thumbs up"]);
    expect(names("blush")).toEqual(["smiling face with smiling eyes"]);
  });

  it("matches multi-word names with underscores or spaces", () => {
    expect(names("slightly_smiling")).toEqual(["slightly smiling face"]);
    expect(names("slightly smiling")).toEqual(["slightly smiling face"]);
  });

  it("ranks a shortcode match above a keyword match", () => {
    // "smile" is the start of :smiley: (😃) and only a keyword of the others.
    expect(names("smile")[0]).toBe("grinning face with big eyes");
    expect(names("smile")).toHaveLength(4);
    // An exact shortcode beats a longer name that merely starts the same way.
    expect(names("grinning")[0]).toBe("grinning face");
    expect(names("grin")).toEqual(["grinning face", "grinning face with big eyes"]);
  });

  it("keeps the Unicode order for equal scores and honours the limit", () => {
    // "happy" is a keyword (same score) of both, so 😀 (order 1) comes before 😃 (order 2).
    expect(names("happy")).toEqual(["grinning face", "grinning face with big eyes"]);
    expect(names("smile", 2)).toHaveLength(2);
  });

  it("returns nothing for text that matches nothing", () => {
    expect(names("zzzzqq")).toEqual([]);
  });
});

describe("normaliseQuery / emojiForTone", () => {
  const data = sampleData();
  it("trims, lower-cases and strips colons at both ends", () => {
    expect(normaliseQuery("  :SMI: ")).toBe("smi");
  });
  it("gives the toned variant, or the default when there is none", () => {
    const thumbs = data.byShortcode.get("+1")!;
    expect(emojiForTone(thumbs, 0)).toBe(thumbs.emoji);
    expect(emojiForTone(thumbs, 3)).toBe("👍🏽");
    const cat = data.byShortcode.get("cat")!;
    expect(emojiForTone(cat, 4)).toBe("🐱");
    const shake = data.byShortcode.get("handshake")!;
    expect(emojiForTone(shake, 2)).toBe(shake.emoji);
  });
});
