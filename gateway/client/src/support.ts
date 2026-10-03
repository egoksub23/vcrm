// Small pieces the client is built from: an event emitter, the reconnect delay, the file types, and the stores.

import type { BackoffOptions, ChatStore, MessageKind, StoredState } from './types'

// ------------------------------------------------------------
// Events
// ------------------------------------------------------------

export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>()

  on<E extends keyof Events>(event: E, fn: (payload: Events[E]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(fn as (payload: never) => void)
    return () => set!.delete(fn as (payload: never) => void)
  }

  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) {
      try {
        ;(fn as (p: Events[E]) => void)(payload)
      } catch (err) {
        // A listener that throws must not break the connection.
        if (typeof console !== 'undefined') console.error('[vircle-chat] a listener failed:', err)
      }
    }
  }
}

// ------------------------------------------------------------
// Reconnect delay
// ------------------------------------------------------------

export const DEFAULT_BACKOFF: BackoffOptions = { minMs: 1000, maxMs: 30_000, factor: 2, jitter: 0.3 }

/**
 * The wait before attempt number `attempt` (0 for the first retry): 1 s, 2 s, 4 s ... up to the maximum, each
 * randomised by plus or minus `jitter` so that many phones coming back at once do not arrive together.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions, random: () => number = Math.random): number {
  const base = Math.min(opts.maxMs, opts.minMs * Math.pow(opts.factor, Math.max(0, attempt)))
  const spread = base * opts.jitter
  return Math.max(0, Math.round(base - spread + random() * spread * 2))
}

// ------------------------------------------------------------
// Files
// ------------------------------------------------------------

/** What the gateway accepts: the same list as WhatsApp and the web widget. */
export const ALLOWED_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'video/3gpp',
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'audio/ogg',
  'audio/mpeg',
  'audio/aac',
  'audio/mp4',
  'audio/amr',
]

export const DEFAULT_FILE_MAX_BYTES = 16 * 1024 * 1024
export const MAX_VOICE_SECONDS = 300

export const baseMime = (mime: string): string => mime.split(';')[0]!.trim().toLowerCase()

/** The kind of message a file of this type is sent as, or null if the type is not allowed. */
export function kindOfMime(mime: string): Exclude<MessageKind, 'text'> | null {
  const m = baseMime(mime)
  if (!ALLOWED_MIME_TYPES.includes(m)) return null
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  return 'document'
}

// ------------------------------------------------------------
// Stores
// ------------------------------------------------------------

/** Keeps nothing between launches. */
export function memoryStore(): ChatStore {
  let state: StoredState | null = null
  return {
    async load() {
      return state ? (JSON.parse(JSON.stringify(state)) as StoredState) : null
    },
    async save(next) {
      state = JSON.parse(JSON.stringify(next)) as StoredState
    },
    async clear() {
      state = null
    },
  }
}

/**
 * Keeps the conversation in `localStorage` (or any object with the same three methods, for example a wrapper around
 * Ionic Storage), under `key`. Use a key that includes the signed-in user, and call `clear()` when they sign out.
 * Every failure of the storage is swallowed: the chat works without it.
 */
export function localStorageStore(key: string, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = safeLocalStorage()): ChatStore {
  return {
    async load() {
      try {
        const raw = storage?.getItem(key)
        if (!raw) return null
        const parsed = JSON.parse(raw) as StoredState
        return parsed && parsed.v === 1 && Array.isArray(parsed.messages) ? parsed : null
      } catch {
        return null
      }
    },
    async save(state) {
      try {
        storage?.setItem(key, JSON.stringify(state))
      } catch {
        /* full or blocked: the chat still works */
      }
    },
    async clear() {
      try {
        storage?.removeItem(key)
      } catch {
        /* nothing to do */
      }
    },
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}
