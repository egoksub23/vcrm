import type { EmojiData, EmojiEntry, SkinTone } from "./types";

/** The emoji to insert for an entry at the chosen skin tone (falls back to the default). */
export function emojiForTone(entry: EmojiEntry, tone: SkinTone): string {
  if (tone === 0 || !entry.skins) return entry.emoji;
  return entry.skins[tone - 1] || entry.emoji;
}

/** Strips the colons a user may have typed (":smi", ":smile:") and lower-cases. */
export function normaliseQuery(query: string): string {
  return query.trim().toLowerCase().replace(/^:+/, "").replace(/:+$/, "");
}

function scoreEntry(e: EmojiEntry, q: string, qSpaced: string): number {
  let best = 0;
  for (const code of e.shortcodes) {
    if (code === q) best = Math.max(best, 100);
    else if (code.startsWith(q)) best = Math.max(best, 80);
    else if (code.includes(q)) best = Math.max(best, 50);
  }
  const name = e.name;
  if (name === qSpaced) best = Math.max(best, 90);
  else if (name.startsWith(qSpaced)) best = Math.max(best, 70);
  else if (name.split(/[\s:,-]+/).some((w) => w.startsWith(qSpaced))) best = Math.max(best, 60);
  else if (name.includes(qSpaced)) best = Math.max(best, 30);
  for (const tag of e.tags) {
    const t = tag.toLowerCase();
    if (t === q) best = Math.max(best, 45);
    else if (t.startsWith(q)) best = Math.max(best, 40);
    else if (t.includes(q)) best = Math.max(best, 20);
  }
  return best;
}

/**
 * Case-insensitive search over names, keywords and shortcodes. Best matches
 * first (exact shortcode, then prefixes, then substrings); ties keep the
 * standard Unicode order, so results are stable while typing.
 */
export function searchEmoji(data: EmojiData, query: string, limit = Number.POSITIVE_INFINITY): EmojiEntry[] {
  const q = normaliseQuery(query);
  if (!q) return [];
  const qSpaced = q.replace(/_/g, " ");
  const scored: { e: EmojiEntry; s: number }[] = [];
  for (const e of data.entries) {
    const s = scoreEntry(e, q, qSpaced);
    if (s > 0) scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s || a.e.order - b.e.order);
  return scored.slice(0, limit).map((x) => x.e);
}
