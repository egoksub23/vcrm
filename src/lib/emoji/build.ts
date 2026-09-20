import {
  EMOJI_GROUP_KEYS,
  type EmojiData,
  type EmojiEntry,
  type EmojiGroupKey,
  type RawEmoji,
  type RawShortcodes,
} from "./types";

/**
 * Emojibase group number -> our category. Group 2 is "component" (skin-tone and
 * hair swatches), which is not a thing to send, so it is left out; so are the
 * regional-indicator letters, which carry no group at all.
 */
const GROUP_BY_NUMBER: Record<number, EmojiGroupKey> = {
  0: "smileys",
  1: "people",
  3: "animals",
  4: "food",
  5: "travel",
  6: "activities",
  7: "objects",
  8: "symbols",
  9: "flags",
};

/** Fitzpatrick modifiers 1F3FB..1F3FF are tones 1..5. */
function toneOfSkin(hexcode: string): number {
  const tones = new Set<number>();
  for (const part of hexcode.split("-")) {
    const cp = parseInt(part, 16);
    if (cp >= 0x1f3fb && cp <= 0x1f3ff) tones.add(cp - 0x1f3fa);
  }
  // Exactly one tone used throughout. Pairs with two different tones are skipped:
  // a single selector cannot express them.
  return tones.size === 1 ? [...tones][0] : 0;
}

function shortcodesFor(hexcode: string, sets: RawShortcodes[]): string[] {
  const out: string[] = [];
  for (const set of sets) {
    const v = set[hexcode];
    if (!v) continue;
    for (const s of Array.isArray(v) ? v : [v]) {
      const code = s.toLowerCase();
      if (!out.includes(code)) out.push(code);
    }
  }
  return out;
}

/** Turns the raw Emojibase files into the picker's data. Pure, so it is unit-tested. */
export function buildEmojiData(raw: RawEmoji[], shortcodeSets: RawShortcodes[]): EmojiData {
  const entries: EmojiEntry[] = [];
  const byShortcode = new Map<string, EmojiEntry>();
  const byEmoji = new Map<string, EmojiEntry>();

  for (const r of raw) {
    if (r.group === undefined) continue;
    const group = GROUP_BY_NUMBER[r.group];
    if (!group) continue;

    let skins: string[] | undefined;
    if (r.skins && r.skins.length > 0) {
      const byTone: string[] = ["", "", "", "", ""];
      for (const s of r.skins) {
        const tone = toneOfSkin(s.hexcode);
        if (tone > 0 && !byTone[tone - 1]) byTone[tone - 1] = s.unicode;
      }
      if (byTone.some(Boolean)) skins = byTone;
    }

    const entry: EmojiEntry = {
      emoji: r.unicode,
      name: r.label.toLowerCase(),
      group,
      tags: r.tags ?? [],
      shortcodes: shortcodesFor(r.hexcode, shortcodeSets),
      ...(skins ? { skins } : {}),
      order: r.order ?? entries.length,
    };
    entries.push(entry);
    byEmoji.set(entry.emoji, entry);
    for (const s of skins ?? []) if (s) byEmoji.set(s, entry);
    for (const code of entry.shortcodes) if (!byShortcode.has(code)) byShortcode.set(code, entry);
  }

  entries.sort((a, b) => a.order - b.order);
  const groups = EMOJI_GROUP_KEYS.map((key) => ({
    key,
    entries: entries.filter((e) => e.group === key),
  })).filter((g) => g.entries.length > 0);

  return { entries, groups, byShortcode, byEmoji };
}
