// ============================================================
// Lazy assets. The emoji data and the Ogg/Opus recorder are separate
// classic scripts built next to loader.js (public/widget/emoji.js and
// public/widget/recorder.js) and pulled in on first use from the SAME
// origin the loader came from — never from a CDN, so a host page whose
// CSP already allows our loader.js needs no extra allow-list entries.
// Each script registers itself on window.__vircleWidgetLazy.
// ============================================================
import { API_ORIGIN } from './api'
import type { VoiceHandle } from './recorder-strategy'

export interface EmojiPayload {
  /** Category order + labels are localised in the UI by `key`. */
  groups: Array<{ key: string; items: Array<[emoji: string, keywords: string]> }>
}

export interface RecorderChunk {
  /** Start an in-browser Ogg/Opus recording (asks for the microphone; null = browser default). */
  startOpus(deviceId?: string | null): Promise<VoiceHandle>
}

interface LazyRegistry {
  emoji?: EmojiPayload
  recorder?: RecorderChunk
}

declare global {
  interface Window {
    __vircleWidgetLazy?: LazyRegistry
  }
}

declare const __WIDGET_BUILD__: string

const inflight = new Map<string, Promise<unknown>>()

function loadScript<K extends keyof LazyRegistry>(name: K): Promise<NonNullable<LazyRegistry[K]>> {
  const ready = window.__vircleWidgetLazy?.[name]
  if (ready) return Promise.resolve(ready as NonNullable<LazyRegistry[K]>)
  const existing = inflight.get(name)
  if (existing) return existing as Promise<NonNullable<LazyRegistry[K]>>

  const p = new Promise<NonNullable<LazyRegistry[K]>>((resolve, reject) => {
    const el = document.createElement('script')
    el.async = true
    el.src = `${API_ORIGIN}/widget/${name}.js?v=${encodeURIComponent(__WIDGET_BUILD__)}`
    el.onload = () => {
      const got = window.__vircleWidgetLazy?.[name]
      if (got) resolve(got as NonNullable<LazyRegistry[K]>)
      else reject(new Error(`widget asset ${name} did not register`))
    }
    el.onerror = () => reject(new Error(`widget asset ${name} failed to load`))
    document.head.appendChild(el)
  }).catch((err) => {
    // Let a later attempt retry (offline, or a deploy in between).
    inflight.delete(name)
    throw err
  })
  inflight.set(name, p)
  return p
}

export const loadEmojiPayload = (): Promise<EmojiPayload> => loadScript('emoji')
export const loadRecorderChunk = (): Promise<RecorderChunk> => loadScript('recorder')
