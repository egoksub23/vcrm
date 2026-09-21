// Renders the message bubble WITHOUT a DOM: BubbleImpl and AudioPlayer are plain
// function components, so with the hooks stubbed they can be expanded into a
// tree of host elements and inspected. This is the regression net for
// "a server-delivered voice note blanks the widget".
import { describe, expect, it, vi } from 'vitest'

vi.mock('preact/hooks', () => ({
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
  useRef: () => ({ current: null }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
}))

import { makeTranslator } from './i18n'
import type { LocalMessage } from './types'
import { Guard } from './ui/Guard'
import { BubbleImpl, MessageFallback } from './ui/Bubble'
import { groupMessages, safeGroupMessages, toWidgetMessage } from './util'

const t = makeTranslator('en')

interface Host {
  tag: string
  props: Record<string, unknown>
  children: Array<Host | string>
}

/** Expand vnodes into host elements, calling function components (not classes). */
function expand(node: unknown): Array<Host | string> {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(expand)
  const v = node as { type: unknown; props: Record<string, unknown> }
  if (typeof v.type === 'function') {
    const fn = v.type as ((p: unknown) => unknown) & { prototype?: { render?: unknown } }
    if (fn.prototype && typeof fn.prototype.render === 'function') return expand(v.props.children)
    return expand(fn(v.props))
  }
  const { children, ...props } = v.props
  return [{ tag: String(v.type), props, children: expand(children) }]
}

function find(nodes: Array<Host | string>, pred: (h: Host) => boolean): Host[] {
  const out: Host[] = []
  for (const n of nodes) {
    if (typeof n === 'string') continue
    if (pred(n)) out.push(n)
    out.push(...find(n.children, pred))
  }
  return out
}

function text(nodes: Array<Host | string>): string {
  return nodes.map((n) => (typeof n === 'string' ? n : text(n.children))).join('')
}

const props = (m: LocalMessage) => ({
  m,
  locale: 'en' as const,
  t,
  onRetry: () => {},
  onOpenImage: () => {},
})

// The exact rows from the production DB (conversation 6837158e, 2026-09-21).
const AGENT_VOICE_ROW = {
  id: '5af44fe5-9f0e-495d-adcf-88d42bdd2c47',
  sender_type: 'agent',
  content_text: null,
  content_type: 'audio',
  media_url:
    'https://obhotegtfluveogakrjy.supabase.co/storage/v1/object/public/chat-media/account-a067c4ed-4f53-4c1c-a007-bf6f3bc4d86b/1789995443383-voice-1789995443271.ogg',
  status: 'sent',
  created_at: '2026-09-21 12:57:26.613614+00',
  is_internal: false,
  // extra columns a Realtime payload carries; the widget must ignore them
  media_type: null,
  channel_type: 'web_widget',
  message_id: null,
  content_html: null,
  mentions: [],
}
const CUSTOMER_VOICE_ROW = {
  ...AGENT_VOICE_ROW,
  id: '90d222c0-6ae2-4bf8-adc7-15cf914e59d8',
  sender_type: 'customer',
  media_type: 'audio/ogg',
  status: 'read',
  created_at: '2026-09-21 12:56:51.03963+00',
  media_url:
    'https://obhotegtfluveogakrjy.supabase.co/storage/v1/object/public/chat-media/account-a067c4ed-4f53-4c1c-a007-bf6f3bc4d86b/widget/6837158e-10e4-4e80-997e-e8464498580c/8a0c475a-c7bf-42db-afda-a98d48eb5b63-voice-1789995407904.ogg',
}

describe('a server-delivered voice note renders', () => {
  it('parses the real agent audio row (null text, null media_type, .ogg url)', () => {
    const m = toWidgetMessage(AGENT_VOICE_ROW)
    expect(m).toMatchObject({
      id: AGENT_VOICE_ROW.id,
      sender_type: 'agent',
      content_type: 'audio',
      content_text: null,
      media_url: AGENT_VOICE_ROW.media_url,
      status: 'sent',
    })
    expect(m).not.toHaveProperty('channel_type')
  })

  it('draws an audio player (no local duration hint) instead of throwing', () => {
    const m = toWidgetMessage(AGENT_VOICE_ROW)!
    const tree = expand(BubbleImpl(props(m)))
    const audio = find(tree, (h) => h.tag === 'audio')
    expect(audio).toHaveLength(1)
    expect(audio[0].props.src).toBe(AGENT_VOICE_ROW.media_url)
    expect(find(tree, (h) => h.tag === 'input' && h.props.type === 'range')).toHaveLength(1)
    expect(text(tree)).toContain('0:00') // duration unknown until the browser reads the file
  })

  it('also renders the customer voice note as it comes back from the server (after F5)', () => {
    const m = toWidgetMessage(CUSTOMER_VOICE_ROW)!
    const tree = expand(BubbleImpl(props(m)))
    expect(find(tree, (h) => h.tag === 'audio')).toHaveLength(1)
  })

  it('renders every media type the server can deliver, with and without captions', () => {
    const base = { ...AGENT_VOICE_ROW }
    const variants = [
      { content_type: 'audio', media_url: 'https://x.test/a/b.mp3?token=1#t' },
      { content_type: 'audio', media_url: 'https://x.test/voice.m4a', content_text: 'listen' },
      { content_type: 'audio', media_url: '' },
      { content_type: 'audio', media_url: null },
      { content_type: 'audio', media_url: 'not a url at all %E0%A4%A' },
      { content_type: 'image', media_url: 'https://x.test/p.jpg' },
      { content_type: 'video', media_url: 'https://x.test/v.mp4' },
      { content_type: 'document', media_url: 'https://x.test/Report%20Q3.pdf' },
      { content_type: 'interactive', media_url: null, content_text: 'pick one' },
      { content_type: null, media_url: null, content_text: 'plain' },
      { content_type: 'text', media_url: null, content_text: null },
    ]
    for (const v of variants) {
      const m = toWidgetMessage({ ...base, ...v })!
      expect(m, JSON.stringify(v)).toBeTruthy()
      expect(() => expand(BubbleImpl(props(m))), JSON.stringify(v)).not.toThrow()
    }
  })

  it('groups a mixed history (WhatsApp + widget rows) without throwing', () => {
    const rows = [AGENT_VOICE_ROW, CUSTOMER_VOICE_ROW, { ...AGENT_VOICE_ROW, id: 'x1', created_at: '2026-09-20 09:43:12.713391+00' }]
    const messages = rows.map((r) => toWidgetMessage(r)!).sort((a, b) => a.created_at.localeCompare(b.created_at))
    const items = groupMessages(messages, { locale: 'en', now: new Date(), t })
    expect(items.filter((i) => i.type === 'message')).toHaveLength(3)
  })
})

describe('a bad message can never blank the chat', () => {
  it('drops rows the widget cannot place instead of producing NaN dates', () => {
    expect(toWidgetMessage({ id: '', created_at: '2026-09-21T12:00:00Z' })).toBeNull()
    expect(toWidgetMessage({ id: 'a', created_at: 'garbage' })).toBeNull()
    expect(toWidgetMessage({ id: 'a' })).toBeNull()
    expect(toWidgetMessage({ id: 5, created_at: '2026-09-21T12:00:00Z' })).toBeNull()
    expect(toWidgetMessage(null)).toBeNull()
    expect(toWidgetMessage(undefined)).toBeNull()
  })

  it('safeGroupMessages falls back to a plain list if grouping throws', () => {
    const m = toWidgetMessage(AGENT_VOICE_ROW)!
    const boom = (() => {
      throw new Error('boom')
    }) as unknown as typeof t
    // dayLabel() calls t(); a throwing translator makes groupMessages throw.
    expect(() => groupMessages([m], { locale: 'en', now: new Date(), t: boom })).toThrow()
    const items = safeGroupMessages([m], { locale: 'en', now: new Date(), t: boom })
    expect(items).toEqual([{ type: 'message', key: m.id, message: m }])
  })

  it('Guard shows its fallback after a render error, and retries when the row changes', () => {
    const fallback = vi.fn(() => 'FALLBACK')
    const g = new Guard({ fallback, resetKey: 'sent', children: 'CHILD' } as never)
    expect(g.render()).toBe('CHILD')

    g.state = { ...g.state, ...Guard.getDerivedStateFromError() }
    expect(g.render()).toBe('FALLBACK')
    expect(fallback).toHaveBeenCalledTimes(1)

    // same key: stays failed (no render loop)
    expect(Guard.getDerivedStateFromProps({ fallback, resetKey: 'sent' }, g.state)).toBeNull()
    // status update on the row: gets another chance
    expect(Guard.getDerivedStateFromProps({ fallback, resetKey: 'read' }, g.state)).toEqual({ failed: false, key: 'read' })
  })

  it('the degraded bubble is never blank and still offers the file', () => {
    const m = toWidgetMessage(AGENT_VOICE_ROW)!
    const tree = expand(MessageFallback({ m, t }))
    expect(text(tree)).toContain(t('messageUnavailable'))
    const link = find(tree, (h) => h.tag === 'a')
    expect(link).toHaveLength(1)
    expect(link[0].props.href).toBe(AGENT_VOICE_ROW.media_url)

    const noMedia = expand(MessageFallback({ m: { ...m, media_url: 'javascript:alert(1)' }, t }))
    expect(find(noMedia, (h) => h.tag === 'a')).toHaveLength(0)
  })
})
