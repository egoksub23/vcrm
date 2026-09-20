import { buildEmojiData } from "./build";
import type { RawEmoji, RawShortcodes } from "./types";

/** A tiny Emojibase-shaped sample: enough to exercise grouping, tones, tags and shortcodes. */
export const RAW: RawEmoji[] = [
  { hexcode: "1F600", label: "grinning face", unicode: "😀", group: 0, order: 1, tags: ["cheerful", "happy", "smile", "grin"] },
  { hexcode: "1F603", label: "grinning face with big eyes", unicode: "😃", group: 0, order: 2, tags: ["happy", "smile", "mouth"] },
  { hexcode: "1F642", label: "slightly smiling face", unicode: "🙂", group: 0, order: 3, tags: ["smile", "slight"] },
  { hexcode: "1F60A", label: "smiling face with smiling eyes", unicode: "😊", group: 0, order: 4, tags: ["blush", "eye", "smile"] },
  {
    hexcode: "1F44D",
    label: "thumbs up",
    unicode: "👍️",
    group: 1,
    order: 10,
    tags: ["+1", "good", "like", "yes"],
    skins: [
      { hexcode: "1F44D-1F3FB", label: "thumbs up: light skin tone", unicode: "👍🏻", group: 1 },
      { hexcode: "1F44D-1F3FC", label: "thumbs up: medium-light skin tone", unicode: "👍🏼", group: 1 },
      { hexcode: "1F44D-1F3FD", label: "thumbs up: medium skin tone", unicode: "👍🏽", group: 1 },
      { hexcode: "1F44D-1F3FE", label: "thumbs up: medium-dark skin tone", unicode: "👍🏾", group: 1 },
      { hexcode: "1F44D-1F3FF", label: "thumbs up: dark skin tone", unicode: "👍🏿", group: 1 },
    ],
  },
  {
    // Two different tones in one skin: no single tone applies, so it is skipped.
    hexcode: "1F91D",
    label: "handshake",
    unicode: "🤝",
    group: 1,
    order: 11,
    tags: ["deal", "agreement"],
    skins: [
      { hexcode: "1F91D-1F3FB", label: "handshake: light skin tone", unicode: "🤝🏻", group: 1 },
      { hexcode: "1FAF1-1F3FB-200D-1FAF2-1F3FC", label: "handshake: light, medium-light", unicode: "🫱🏻‍🫲🏼", group: 1 },
    ],
  },
  { hexcode: "1F431", label: "cat face", unicode: "🐱", group: 3, order: 20, tags: ["cat", "pet"] },
  { hexcode: "1F355", label: "pizza", unicode: "🍕", group: 4, order: 30, tags: ["cheese", "slice"] },
  { hexcode: "1F1F0-1F1F7", label: "flag: South Korea", unicode: "🇰🇷", group: 9, order: 40, tags: ["korea"] },
  // Left out: a component (skin-tone swatch) and a regional indicator letter.
  { hexcode: "1F3FB", label: "light skin tone", unicode: "🏻", group: 2, order: 50 },
  { hexcode: "1F1E6", label: "regional indicator A", unicode: "🇦" },
];

export const CODES_GITHUB: RawShortcodes = {
  "1F44D": ["+1", "thumbsup"],
  "1F600": "grinning",
  "1F603": "smiley",
  "1F642": "slightly_smiling_face",
  "1F60A": "blush",
  "1F431": "cat",
  "1F355": "pizza",
};
export const CODES_CLDR: RawShortcodes = {
  "1F44D": "thumbs_up",
  "1F600": "grinning_face",
  "1F603": "grinning_face_with_big_eyes",
  "1F60A": "smiling_face_with_smiling_eyes",
  "1F1F0-1F1F7": "flag_south_korea",
  "1F91D": "handshake",
};

export const sampleData = () => buildEmojiData(RAW, [CODES_GITHUB, CODES_CLDR]);
