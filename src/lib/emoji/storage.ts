import type { SkinTone } from "./types";

/** Versioned so a future change of shape can start clean instead of migrating. */
export const RECENT_KEY = "vircle.emoji.recent.v1";
export const TONE_KEY = "vircle.emoji.tone.v1";
export const RECENT_MAX = 16;

// localStorage can be missing or throw (private window, blocked site data, a
// preview). Everything here is best effort: the last values also live in memory,
// so "Frequently used" still works for the rest of the page's life.
let memoryRecent: string[] = [];
let memoryTone: SkinTone = 0;

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the in-memory copy still serves this session */
  }
}

export function readRecent(): string[] {
  const raw = readRaw(RECENT_KEY);
  if (raw === null) return memoryRecent;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, RECENT_MAX);
    }
  } catch {
    /* corrupt value: fall through */
  }
  return memoryRecent;
}

/** Puts `emoji` first in the list (moving it if already there) and saves. Returns the new list. */
export function pushRecent(emoji: string): string[] {
  const next = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  memoryRecent = next;
  writeRaw(RECENT_KEY, JSON.stringify(next));
  return next;
}

export function readTone(): SkinTone {
  const raw = readRaw(TONE_KEY);
  const n = raw === null ? memoryTone : Number(raw);
  return n >= 0 && n <= 5 && Number.isInteger(n) ? (n as SkinTone) : 0;
}

export function writeTone(tone: SkinTone): void {
  memoryTone = tone;
  writeRaw(TONE_KEY, String(tone));
}

/** Test hook: forget the in-memory copies. */
export function resetEmojiStorageForTests(): void {
  memoryRecent = [];
  memoryTone = 0;
}
