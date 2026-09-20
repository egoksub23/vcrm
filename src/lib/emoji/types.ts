/** Emoji picker data model. Kept free of React and of the (large) data files. */

/** The picker's categories, in display order. */
export const EMOJI_GROUP_KEYS = [
  "smileys",
  "people",
  "animals",
  "food",
  "travel",
  "activities",
  "objects",
  "symbols",
  "flags",
] as const;

export type EmojiGroupKey = (typeof EMOJI_GROUP_KEYS)[number];

/** 0 = the default (yellow) emoji, 1..5 = light .. dark skin tone. */
export type SkinTone = 0 | 1 | 2 | 3 | 4 | 5;

export interface EmojiEntry {
  /** The glyph (a Unicode string, several UTF-16 units for most emoji). */
  emoji: string;
  /** English CLDR name, lower case ("grinning face"). */
  name: string;
  group: EmojiGroupKey;
  /** Search keywords ("smile", "happy"). */
  tags: string[];
  /** `:shortcode:` names without the colons, most common first. */
  shortcodes: string[];
  /**
   * Single-tone variants, index 0..4 = tone 1..5. Only present for emoji that
   * take a skin tone; an empty string marks a tone this emoji has no variant for.
   */
  skins?: string[];
  /** Position in the Unicode emoji ordering, used to keep results stable. */
  order: number;
}

export interface EmojiGroup {
  key: EmojiGroupKey;
  entries: EmojiEntry[];
}

export interface EmojiData {
  entries: EmojiEntry[];
  groups: EmojiGroup[];
  /** Lower-case shortcode -> entry. */
  byShortcode: Map<string, EmojiEntry>;
  /** Any glyph (base or skin variant) -> entry, for names and aria labels. */
  byEmoji: Map<string, EmojiEntry>;
}

/** Shape of one item in `emojibase-data/en/compact.json` (only what is read). */
export interface RawEmoji {
  hexcode: string;
  label: string;
  unicode: string;
  group?: number;
  order?: number;
  tags?: string[];
  skins?: RawEmoji[];
}

/** `emojibase-data/en/shortcodes/*.json`: hexcode -> one or several shortcodes. */
export type RawShortcodes = Record<string, string | string[]>;
