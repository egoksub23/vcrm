// ============================================================
// Per-channel / per-thread composer drafts, saved to localStorage so a
// half-typed message survives navigating away and back. Best-effort,
// same wrapped-localStorage convention as src/lib/emoji/storage.ts:
// localStorage can be missing or throw (private window, blocked site
// data, a preview) — every read/write here swallows that and falls
// back to an in-memory copy for the rest of the session.
// ============================================================

const CHANNEL_PREFIX = 'vircle.sembang.draft.v1.'
const THREAD_PREFIX = 'vircle.sembang.threadDraft.v1.'

const memoryChannelDrafts = new Map<string, string>()
const memoryThreadDrafts = new Map<string, string>()

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: the in-memory copy still serves this session */
  }
}

function removeRaw(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export function readChannelDraft(channelId: string): string {
  const raw = readRaw(CHANNEL_PREFIX + channelId)
  return raw ?? memoryChannelDrafts.get(channelId) ?? ''
}

export function writeChannelDraft(channelId: string, text: string): void {
  const key = CHANNEL_PREFIX + channelId
  if (text) {
    memoryChannelDrafts.set(channelId, text)
    writeRaw(key, text)
  } else {
    memoryChannelDrafts.delete(channelId)
    removeRaw(key)
  }
}

export function readThreadDraft(parentMessageId: string): string {
  const raw = readRaw(THREAD_PREFIX + parentMessageId)
  return raw ?? memoryThreadDrafts.get(parentMessageId) ?? ''
}

export function writeThreadDraft(parentMessageId: string, text: string): void {
  const key = THREAD_PREFIX + parentMessageId
  if (text) {
    memoryThreadDrafts.set(parentMessageId, text)
    writeRaw(key, text)
  } else {
    memoryThreadDrafts.delete(parentMessageId)
    removeRaw(key)
  }
}

/** Every channel id with a saved, non-empty main-channel draft — for the
 *  global Drafts panel. Thread-reply drafts aren't surfaced there (no
 *  cheap way to show "which thread" without fetching each parent
 *  message; scoped out for this pass, threads still save/restore their
 *  own draft locally, just not listed globally). Falls back to the
 *  in-memory map's own keys if localStorage itself is unavailable. */
export function listDraftChannelIds(): string[] {
  try {
    const ids: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key?.startsWith(CHANNEL_PREFIX)) ids.push(key.slice(CHANNEL_PREFIX.length))
    }
    return ids
  } catch {
    return Array.from(memoryChannelDrafts.keys())
  }
}

/** Test hook: forget the in-memory copies. */
export function resetSembangDraftsForTests(): void {
  memoryChannelDrafts.clear()
  memoryThreadDrafts.clear()
}
