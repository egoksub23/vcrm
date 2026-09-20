/**
 * The emoji data itself: Emojibase (MIT), installed from npm and bundled with the
 * app, so the picker never calls out to a CDN (the CSP would not allow it either).
 *
 * This module is only ever reached through the dynamic `import()` in `data.ts`,
 * which makes the ~600 KB of JSON below its own chunk. It is fetched the first
 * time a picker opens or `:` is typed, and never sits in the main bundle.
 */
import compact from "emojibase-data/en/compact.json";
import github from "emojibase-data/en/shortcodes/github.json";
import cldr from "emojibase-data/en/shortcodes/cldr.json";

import { buildEmojiData } from "./build";
import type { EmojiData, RawEmoji, RawShortcodes } from "./types";

// GitHub names first (`:+1:`, `:thumbsup:`), then the CLDR ones (`:thumbs_up:`).
export const emojiData: EmojiData = buildEmojiData(compact as unknown as RawEmoji[], [
  github as unknown as RawShortcodes,
  cldr as unknown as RawShortcodes,
]);
