import { describe, expect, it } from "vitest";

import { sampleData } from "./test-fixtures";
import { EMOJI_GROUP_KEYS } from "./types";

describe("buildEmojiData: category grouping", () => {
  const data = sampleData();

  it("keeps only real emoji and drops components and regional indicators", () => {
    expect(data.entries.map((e) => e.name)).not.toContain("light skin tone");
    expect(data.entries.map((e) => e.name)).not.toContain("regional indicator a");
    expect(data.entries).toHaveLength(9);
  });

  it("groups in the picker order and omits empty categories", () => {
    expect(data.groups.map((g) => g.key)).toEqual(["smileys", "people", "animals", "food", "flags"]);
    const order = data.groups.map((g) => EMOJI_GROUP_KEYS.indexOf(g.key));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("puts each emoji in its category, in Unicode order", () => {
    expect(data.groups[0].entries.map((e) => e.emoji)).toEqual(["😀", "😃", "🙂", "😊"]);
    expect(data.groups.find((g) => g.key === "flags")?.entries[0].name).toBe("flag: south korea");
  });

  it("merges shortcodes from every source, GitHub names first, without duplicates", () => {
    const thumbs = data.byShortcode.get("thumbsup");
    expect(thumbs?.shortcodes).toEqual(["+1", "thumbsup", "thumbs_up"]);
    expect(data.byShortcode.get("+1")).toBe(thumbs);
    expect(data.byShortcode.get("thumbs_up")).toBe(thumbs);
  });

  it("builds one variant per skin tone, and skips skins that mix tones", () => {
    const thumbs = data.byShortcode.get("+1")!;
    expect(thumbs.skins).toEqual(["👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"]);
    const shake = data.byShortcode.get("handshake")!;
    expect(shake.skins).toEqual(["🤝🏻", "", "", "", ""]);
    expect(data.byShortcode.get("cat")?.skins).toBeUndefined();
  });

  it("looks an emoji up by glyph, including its skin variants", () => {
    expect(data.byEmoji.get("👍🏾")?.name).toBe("thumbs up");
    expect(data.byEmoji.get("🐱")?.name).toBe("cat face");
    expect(data.byEmoji.get("nope")).toBeUndefined();
  });
});

describe("the real Emojibase data", () => {
  it("loads, is complete enough, and resolves the shortcodes people type", async () => {
    const { emojiData } = await import("./dataset");
    expect(emojiData.entries.length).toBeGreaterThan(1500);
    expect(emojiData.groups.map((g) => g.key)).toEqual([...EMOJI_GROUP_KEYS]);
    for (const g of emojiData.groups) expect(g.entries.length).toBeGreaterThan(20);
    expect(emojiData.byShortcode.get("smile")?.emoji).toBeTruthy();
    expect(emojiData.byShortcode.get("+1")?.name).toBe("thumbs up");
    expect(emojiData.byShortcode.get("thumbsup")?.skins).toHaveLength(5);
    expect(emojiData.byShortcode.get("heart")?.emoji).toContain("❤");
    // Every entry has a name and a glyph; no skin-tone component leaked in.
    for (const e of emojiData.entries) {
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.emoji.length).toBeGreaterThan(0);
    }
    expect(emojiData.entries.some((e) => /^(light|dark|medium)[a-z -]* skin tone$/.test(e.name))).toBe(false);
  });
});
