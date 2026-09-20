import type { EmojiData } from "./types";

let loaded: EmojiData | null = null;
let pending: Promise<EmojiData> | null = null;

/** The data if it has already been loaded, else null. Never triggers a load. */
export function getLoadedEmojiData(): EmojiData | null {
  return loaded;
}

/**
 * Loads the emoji data once. The dynamic import keeps the data out of the main
 * bundle: the browser fetches the chunk the first time this is called.
 */
export function loadEmojiData(): Promise<EmojiData> {
  if (loaded) return Promise.resolve(loaded);
  if (!pending) {
    pending = import("./dataset")
      .then((m) => {
        loaded = m.emojiData;
        return m.emojiData;
      })
      .catch((err) => {
        // A failed chunk fetch (offline, deploy in between) can be retried later.
        pending = null;
        throw err;
      });
  }
  return pending;
}
