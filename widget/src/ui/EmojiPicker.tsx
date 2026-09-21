import { useEffect, useMemo, useState } from 'preact/hooks'

import { loadEmojiPayload, type EmojiPayload } from '../lazy'
import type { StringKey, Translate } from '../i18n'
import { SearchIcon } from './icons'

const RECENT_KEY = 'vcw:emoji:recent'
const RECENT_MAX = 24
const MAX_SEARCH_RESULTS = 120

const GROUP_LABELS: Record<string, StringKey> = {
  smileys: 'catSmileys',
  people: 'catPeople',
  animals: 'catAnimals',
  food: 'catFood',
  travel: 'catTravel',
  activities: 'catActivities',
  objects: 'catObjects',
  symbols: 'catSymbols',
  flags: 'catFlags',
}

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

function pushRecent(emoji: string): string[] {
  const next = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX)
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* private mode: recents just are not remembered */
  }
  return next
}

/**
 * Emoji panel. The dataset (public/widget/emoji.js, ~70 KB) is fetched
 * from the API origin the first time the panel opens — never bundled
 * into loader.js and never pulled from a CDN.
 */
export function EmojiPicker({ t, onPick }: { t: Translate; onPick: (emoji: string) => void }) {
  const [payload, setPayload] = useState<EmojiPayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [tab, setTab] = useState<string>('')
  const [query, setQuery] = useState('')
  const [recent, setRecent] = useState<string[]>(readRecent)

  useEffect(() => {
    let cancelled = false
    loadEmojiPayload().then(
      (p) => {
        if (!cancelled) setPayload(p)
      },
      () => {
        if (!cancelled) setFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const activeTab = tab || (recent.length > 0 ? 'recent' : (payload?.groups[0]?.key ?? ''))

  const shown = useMemo<string[]>(() => {
    if (!payload) return []
    const q = query.trim().toLowerCase()
    if (q) {
      const out: string[] = []
      for (const g of payload.groups) {
        for (const [emoji, keywords] of g.items) {
          if (keywords.includes(q)) {
            out.push(emoji)
            if (out.length >= MAX_SEARCH_RESULTS) return out
          }
        }
      }
      return out
    }
    if (activeTab === 'recent') return recent
    return payload.groups.find((g) => g.key === activeTab)?.items.map((i) => i[0]) ?? []
  }, [payload, query, activeTab, recent])

  const pick = (emoji: string) => {
    setRecent(pushRecent(emoji))
    onPick(emoji)
  }

  if (failed) return <div class="wcw-emoji wcw-emoji-msg">{t('emojiFailed')}</div>
  if (!payload) return <div class="wcw-emoji wcw-emoji-msg">{t('emojiLoading')}</div>

  return (
    <div class="wcw-emoji">
      <div class="wcw-emoji-search">
        <SearchIcon />
        <input
          type="search"
          placeholder={t('emojiSearch')}
          aria-label={t('emojiSearch')}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>
      {!query && (
        <div class="wcw-emoji-tabs" role="tablist">
          {recent.length > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'recent'}
              aria-label={t('emojiRecent')}
              title={t('emojiRecent')}
              class={activeTab === 'recent' ? 'wcw-on' : ''}
              onClick={() => setTab('recent')}
            >
              🕘
            </button>
          )}
          {payload.groups.map((g) => (
            <button
              type="button"
              key={g.key}
              role="tab"
              aria-selected={activeTab === g.key}
              aria-label={t(GROUP_LABELS[g.key] ?? 'catObjects')}
              title={t(GROUP_LABELS[g.key] ?? 'catObjects')}
              class={activeTab === g.key ? 'wcw-on' : ''}
              onClick={() => setTab(g.key)}
            >
              {g.items[0]?.[0]}
            </button>
          ))}
        </div>
      )}
      <div class="wcw-emoji-grid">
        {shown.length === 0 ? (
          <div class="wcw-emoji-msg">{t('emojiNone')}</div>
        ) : (
          shown.map((e) => (
            <button type="button" key={e} class="wcw-emoji-btn" onClick={() => pick(e)} aria-label={e}>
              {e}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
