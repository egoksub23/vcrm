import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider, createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'

import { commentCapabilities } from '@/lib/comments/types'
import type { InboxPost, ThreadComment, ThreadPost } from '@/lib/comments/threads'
import { AuthorBlock } from './author-block'
import { BulkBar } from './bulk-bar'
import { CommentPostRow } from './post-row'
import { PostThreadView, type PostThreadViewProps } from './post-thread-view'

// Render tests for the Comments inbox grouped by post (the list row, the thread, the grouped author block and the bulk bar), in the four
// languages with the real catalogues. next-intl errors (a missing key or argument) are thrown, so a string that is not in a catalogue fails here
// rather than showing a raw key path to an agent.

const LOCALES = ['en', 'ms', 'zh', 'ko'] as const
const cache = new Map<string, unknown>()
const load = (locale: string) => {
  if (!cache.has(locale)) cache.set(locale, JSON.parse(readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8')))
  return cache.get(locale) as Record<string, unknown>
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

function render(locale: string, node: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={load(locale)}
      onError={(e: Error) => {
        throw e
      }}
    >
      {node}
    </NextIntlClientProvider>,
  )
}
const tr = (locale: string) => {
  const t = createTranslator({ locale, messages: load(locale), namespace: 'Comments' })
  return (key: string, values?: Record<string, string | number>) => esc(t(key as never, values as never))
}

// ---- data ---------------------------------------------------------------------------------------------------------------------------------

const NOW = Date.now()
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

let seq = 0
function comment(over: Partial<ThreadComment> & { ago?: number } = {}): ThreadComment {
  seq += 1
  const { ago = 100 - seq, ...rest } = over
  const base = {
    id: `c${seq}`,
    post_id: 'p1',
    provider: 'instagram' as const,
    external_comment_id: `ext${seq}`,
    parent_comment_id: null,
    parent_external_id: null,
    direction: 'inbound' as const,
    author_external_id: `u${seq}`,
    author_name: `Person ${seq}`,
    author_username: `person${seq}`,
    author_avatar_url: null,
    contact_id: null,
    text: `comment text ${seq}`,
    attachment_url: null,
    status: 'visible' as const,
    handled_status: 'open' as const,
    assigned_to: null,
    private_replied_at: null,
    is_test: false,
    provider_created_at: iso(ago),
    created_at: iso(ago),
  }
  const merged = { ...base, ...rest }
  return { ...merged, capabilities: commentCapabilities(merged) }
}

const post: ThreadPost = {
  id: 'p1',
  provider: 'instagram',
  source: 'organic',
  external_post_id: 'ig-1',
  message: 'Raya giveaway: tell us your plans',
  permalink_url: 'https://example.invalid/p/1',
  media_url: 'https://example.invalid/p1.jpg',
  media_type: 'IMAGE',
  posted_at: null,
}

const inboxPost = (over: Partial<InboxPost> = {}): InboxPost => ({
  post_id: 'p1',
  provider: 'instagram',
  source: 'organic',
  external_post_id: 'ig-1',
  message: 'Raya giveaway: tell us your plans',
  permalink_url: null,
  media_url: 'https://example.invalid/p1.jpg',
  media_type: 'IMAGE',
  posted_at: null,
  open_count: 4,
  done_count: 2,
  spam_count: 0,
  total_count: 6,
  last_comment_id: 'c9',
  last_comment_text: 'Count me in!',
  last_author_name: 'Bob',
  last_author_username: 'bob_b',
  last_comment_at: iso(5),
  last_provider_created_at: iso(5),
  has_test: false,
  unread: true,
  seen_at: null,
  ...over,
})

const noop = () => {}
const DISABLED = /\sdisabled(=""|\s|>)/
const handlers = { onToggleSelect: noop, onReply: noop, onVisibility: noop, onDelete: noop, onHandled: noop }

function thread(comments: ThreadComment[], over: Partial<PostThreadViewProps> = {}): React.ReactElement {
  return (
    <PostThreadView
      post={post}
      comments={comments}
      truncated={false}
      newIds={new Set()}
      highlightId={null}
      selected={new Set()}
      target={null}
      text=""
      busyByComment={{}}
      bulkBusy={false}
      sending={false}
      canWrite
      canDelete={false}
      failures={[]}
      onBack={noop}
      onText={noop}
      onSend={noop}
      onCancelReply={noop}
      onClearSelection={noop}
      onBulk={noop}
      onDismissFailures={noop}
      handlers={handlers}
      {...over}
    />
  )
}

// ---- the list row -------------------------------------------------------------------------------------------------------------------------

describe('CommentPostRow', () => {
  for (const locale of LOCALES) {
    it(`shows a post as one row, in ${locale}`, () => {
      const t = tr(locale)
      const html = render(locale, <CommentPostRow post={inboxPost()} active={false} unread onSelect={noop} />)
      expect(html).toContain('Raya giveaway: tell us your plans'.replace(/'/g, '&#x27;'))
      expect(html).toContain('src="https://example.invalid/p1.jpg"')
      expect(html).toContain(t('toDoCount', { count: 4 }))
      expect(html).toContain(t('commentCount', { count: 6 }))
      expect(html).toContain(t('latestFrom', { author: 'Bob', text: 'Count me in!' }))
      // the dot, named for a screen reader
      expect(html).toContain(`aria-label="${t('unreadDot')}"`)
      expect(html).toContain('font-semibold')
    })
  }

  it('has no dot and a plain caption when nothing is new', () => {
    const html = render('en', <CommentPostRow post={inboxPost()} active={false} unread={false} onSelect={noop} />)
    expect(html).not.toContain('New comments since you last looked')
    expect(html).not.toContain('font-semibold')
  })

  it('hides the to-do badge when nothing is waiting, and says when a post is an ad or holds sample comments', () => {
    const html = render(
      'en',
      <CommentPostRow post={inboxPost({ open_count: 0, source: 'ad', has_test: true, media_url: null })} active unread={false} onSelect={noop} />,
    )
    expect(html).not.toContain('to do')
    expect(html).toContain('Ad post')
    expect(html).toContain('Sample')
    expect(html).not.toContain('<img')
    expect(html).toContain('aria-current="true"')
  })

  it('falls back to the author\'s username, then to "Unknown", and to "No caption"', () => {
    const a = render('en', <CommentPostRow post={inboxPost({ last_author_name: null, message: '' })} active={false} unread={false} onSelect={noop} />)
    expect(a).toContain('bob_b: Count me in!')
    expect(a).toContain('No caption')
    const b = render('en', <CommentPostRow post={inboxPost({ last_author_name: null, last_author_username: null })} active={false} unread={false} onSelect={noop} />)
    expect(b).toContain('Unknown: Count me in!')
  })
})

// ---- the thread ---------------------------------------------------------------------------------------------------------------------------

describe('PostThreadView', () => {
  const aya = (over: Partial<ThreadComment> & { ago?: number } = {}) =>
    comment({ author_external_id: 'aya', author_name: 'Aya', author_username: 'ayakorose645', ...over })

  for (const locale of LOCALES) {
    it(`reads as a conversation under the post card, in ${locale}`, () => {
      const t = tr(locale)
      const first = comment({ id: 'first', ago: 60, text: 'Where do I enter?' })
      const ours = comment({ id: 'ours', ago: 50, direction: 'outbound', parent_comment_id: 'first', text: 'Link in our bio!', author_name: 'Our Page', author_external_id: null })
      const second = comment({ id: 'second', ago: 40, text: 'Thank you', parent_comment_id: 'first' })
      const html = render(locale, thread([second, ours, first]))
      // the post card
      expect(html).toContain(t('onThisPost'))
      expect(html).toContain(t('viewPost'))
      expect(html).toContain('href="https://example.invalid/p/1"')
      // oldest first, replies under the comment they answer
      const order = ['Where do I enter?', 'Link in our bio!', 'Thank you'].map((s) => html.indexOf(s))
      expect(order.every((i) => i > 0)).toBe(true)
      expect(order).toEqual([...order].sort((a, b) => a - b))
      // our own comment is shown as ours; a customer comment carries its actions
      expect(html).toContain(t('you'))
      expect(html).toContain(t('reply'))
      expect(html).toContain(t('privateReply'))
      expect(html).toContain(t('markHandled'))
      expect(html).toContain(t('markSpam'))
      expect(html).toContain(t('hide'))
      // replies are indented
      expect(html).toContain('ml-6')
      // the reply box asks for a comment to answer
      expect(html).toContain(t('chooseComment'))
    })
  }

  it('shows the target line in the reply box, and the box, once a comment is chosen', () => {
    for (const locale of LOCALES) {
      const t = tr(locale)
      const c = comment({ id: 'target', author_name: 'Aya', text: 'love this   so much' })
      const html = render(locale, thread([c], { target: { commentId: 'target', mode: 'reply' } }))
      expect(html).toContain(t('replyingTo', { author: 'Aya', snippet: 'love this so much' }))
      expect(html).toContain(t('cancelReply'))
      expect(html).toContain('<textarea')
      expect(html).not.toContain(t('chooseComment'))
    }
  })

  it('aims the box at a private message when that is what was chosen', () => {
    const c = comment({ id: 'target', provider: 'facebook', author_name: 'Aya', text: 'hello' })
    const html = render('en', thread([c], { target: { commentId: 'target', mode: 'private_reply' } }))
    expect(html).toContain('Private message to Aya: hello')
    expect(html).toContain(tr('en')('privateHint'))
  })

  it('disables Private reply with the existing reason when it is not allowed (TikTok has no private reply)', () => {
    const t = tr('en')
    const tt = comment({ provider: 'tiktok', text: 'nice' })
    const html = render('en', thread([tt], { post: { ...post, provider: 'tiktok' } }))
    const btn = html.match(/<button[^>]*aria-label="Private reply: [^"]*"[^>]*>/)?.[0] ?? ''
    expect(btn).toMatch(DISABLED)
    expect(btn).toContain(esc('TikTok has no way to message someone who commented. Reply publicly instead.'))
    // Reply itself stays on
    const reply = html.match(/<button[^>]*aria-label="Reply"[^>]*>/)?.[0] ?? ''
    expect(reply).not.toMatch(DISABLED)
    expect(t('privateReply')).toBe('Private reply')
  })

  it('shows why a reply is not available when the box is aimed at such a comment', () => {
    const reply = comment({ id: 'r', parent_comment_id: 'p', text: 'reply to a reply' })
    const parent = comment({ id: 'p', ago: 90 })
    const html = render('en', thread([parent, reply], { target: { commentId: 'r', mode: 'reply' } }))
    expect(html).toContain(esc('Instagram only lets you reply to a top-level comment. Reply to the first comment in the thread instead.'))
    expect(html).not.toContain('<textarea')
  })

  it('shows a reply whose parent is not in the thread, marked', () => {
    const lost = comment({ parent_comment_id: null, parent_external_id: 'never-seen', text: 'who am I answering' })
    const html = render('en', thread([lost]))
    expect(html).toContain('who am I answering')
    expect(html).toContain('In reply to a comment that is not shown here')
  })

  it('puts a New divider above the first new comment and tags the new ones', () => {
    for (const locale of LOCALES) {
      const t = tr(locale)
      const old = comment({ id: 'old', ago: 60, text: 'already read' })
      const fresh = comment({ id: 'fresh', ago: 1, text: 'just arrived' })
      const html = render(locale, thread([old, fresh], { newIds: new Set(['fresh']) }))
      const divider = html.indexOf('data-new-divider')
      expect(divider).toBeGreaterThan(html.indexOf('already read'))
      expect(divider).toBeLessThan(html.indexOf('just arrived'))
      expect(html).toContain(t('newDivider'))
    }
    // no divider when nothing is new
    expect(render('en', thread([comment({ text: 'x' })]))).not.toContain('data-new-divider')
  })

  it('outlines the comment a link pointed at', () => {
    const a = comment({ id: 'a', text: 'first' })
    const b = comment({ id: 'b', text: 'linked one' })
    const html = render('en', thread([a, b], { highlightId: 'b' }))
    const li = (id: string) => html.match(new RegExp(`<li[^>]*data-comment-id="${id}"[\\s\\S]*?(?=<li|$)`))?.[0] ?? ''
    expect(li('b')).toContain('ring-2')
    expect(li('a')).not.toContain('ring-2')
    expect(html).toContain('id="comment-b"')
  })

  it('folds one person\'s many open comments into one block, in every language', () => {
    for (const locale of LOCALES) {
      const t = tr(locale)
      const list = Array.from({ length: 11 }, (_, i) => aya({ id: `a${i}`, ago: 200 - i, text: `aya says ${i}` }))
      const html = render(locale, thread([...list, comment({ id: 'bob', text: 'bob says hi', ago: 1 })]))
      expect(html).toContain(t('authorBlock', { author: 'Aya', count: 11 }))
      expect(html).toContain('data-author-block')
      // folded: the comments themselves are not on the page, Bob's is
      expect(html).not.toContain('aya says 3')
      expect(html).toContain('bob says hi')
      // the group actions
      expect(html).toContain(t('markAllHandled'))
      expect(html).toContain(t('hideAll'))
      expect(html).toContain(t('spamAll'))
    }
  })

  it('opens a block to read each comment, each with its own actions', () => {
    const list = Array.from({ length: 3 }, (_, i) => aya({ id: `a${i}`, ago: 200 - i, text: `aya says ${i}` }))
    const html = render('en', thread(list, { expandBlocks: true }))
    for (let i = 0; i < 3; i++) expect(html).toContain(`aya says ${i}`)
    expect((html.match(/data-comment-id=/g) ?? []).length).toBe(3)
    expect((html.match(/aria-label="Reply"/g) ?? []).length).toBe(3)
  })

  it('opens a block by itself when it holds the linked comment or a new one', () => {
    const list = Array.from({ length: 3 }, (_, i) => aya({ id: `a${i}`, ago: 200 - i, text: `aya says ${i}` }))
    expect(render('en', thread(list, { highlightId: 'a1' }))).toContain('aya says 1')
    expect(render('en', thread(list, { newIds: new Set(['a2']) }))).toContain('aya says 2')
  })

  it('does not fold two comments, nor comments that were already handled', () => {
    const two = [aya({ text: 'one' }), aya({ text: 'two' })]
    expect(render('en', thread(two))).not.toContain('data-author-block')
    const handled = [aya({ text: 'one' }), aya({ text: 'two' }), aya({ text: 'three', handled_status: 'resolved' })]
    const html = render('en', thread(handled))
    expect(html).not.toContain('data-author-block')
    expect(html).toContain('three')
  })

  it('shows the bulk bar when comments are ticked, with the ticked ones checked', () => {
    for (const locale of LOCALES) {
      const t = tr(locale)
      const a = comment({ id: 'a' })
      const b = comment({ id: 'b' })
      const html = render(locale, thread([a, b], { selected: new Set(['a', 'b']) }))
      expect(html).toContain(t('selectedCount', { count: 2 }))
      expect(html).toContain(t('clearSelection'))
      expect((html.match(/type="checkbox"[^>]*checked/g) ?? []).length).toBe(2)
    }
    const none = render('en', thread([comment()]))
    expect(none).not.toContain('role="toolbar"')
  })

  it('lists the comments a group action could not change, by person', () => {
    const html = render(
      'en',
      thread([comment()], {
        failures: [
          { id: 'x', who: 'Aya', text: 'first one', error: 'Instagram said no' },
          { id: 'y', who: 'Bob', text: '', error: 'Comment not found.' },
        ],
      }),
    )
    expect(html).toContain('2 comments could not be changed')
    expect(html).toContain('Aya')
    expect(html).toContain('Instagram said no')
    expect(html).toContain('Comment not found.')
    expect(html).toContain('data-bulk-failures')
  })

  it('is read-only without comments.moderate: no ticks, no actions, no reply box', () => {
    const html = render('en', thread([comment({ text: 'read me' })], { canWrite: false }))
    expect(html).toContain('read me')
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('aria-label="Reply"')
    expect(html).not.toContain('data-reply-composer')
  })

  it('shows Delete only to people who may delete', () => {
    const c = comment({})
    expect(render('en', thread([c], { canDelete: false }))).not.toContain('>Delete<')
    expect(render('en', thread([c], { canDelete: true }))).toContain('Delete')
  })

  it('says how a hidden, replied, resolved, spam or sample comment stands', () => {
    const list = [
      comment({ status: 'hidden', text: 'h' }),
      comment({ handled_status: 'replied', text: 'r' }),
      comment({ handled_status: 'resolved', text: 'z' }),
      comment({ handled_status: 'spam', text: 's' }),
      comment({ is_test: true, text: 't' }),
    ]
    const html = render('en', thread(list))
    for (const label of ['Hidden', 'Replied', 'Resolved', 'Spam', 'Sample']) expect(html).toContain(label)
    // a handled comment offers Reopen where an open one offers Mark handled
    expect(html).toContain('Reopen')
  })

  it('has a back arrow for the phone layout and tells how many comments the post has', () => {
    for (const locale of LOCALES) {
      const t = tr(locale)
      const html = render(locale, thread([comment(), comment(), comment({ direction: 'outbound' })]))
      expect(html).toContain(`aria-label="${t('back')}"`)
      expect(html).toContain('lg:hidden')
      expect(html).toContain(t('commentCount', { count: 2 }))
    }
  })

  it('says when older comments were left out', () => {
    expect(render('en', thread([comment()], { truncated: true }))).toContain('Only the newest 1 comments of this post are shown.')
  })
})

// ---- the grouped author block and the bulk bar -------------------------------------------------------------------------------------------

describe('AuthorBlock', () => {
  for (const locale of LOCALES) {
    it(`asks before hiding or marking spam, in ${locale}`, () => {
      const t = tr(locale)
      for (const [op, key] of [['hide', 'confirmHide'], ['spam', 'confirmSpam']] as const) {
        const html = render(
          locale,
          <AuthorBlock label="ayakorose645" count={11} canWrite busy={false} initialConfirm={op} onGroupAction={noop}>
            <li>child</li>
          </AuthorBlock>,
        )
        expect(html).toContain(t(key, { count: 11 }))
        expect(html).toContain(t('confirm'))
        expect(html).toContain(t('cancel'))
        expect(html).toContain('role="alertdialog"')
        // while confirming, the three buttons are replaced
        expect(html).not.toContain(t('markAllHandled'))
      }
    })
  }

  it('shows "name · N comments" and the three group actions, and no actions to a read-only person', () => {
    const html = render('en', <AuthorBlock label="ayakorose645" count={11} canWrite busy={false} onGroupAction={noop}><li>x</li></AuthorBlock>)
    expect(html).toContain('ayakorose645 · 11 comments')
    expect(html).toContain('Mark all handled')
    expect(html).toContain('Hide all')
    expect(html).toContain('Spam all')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('<li>x</li>')
    const ro = render('en', <AuthorBlock label="ayakorose645" count={11} canWrite={false} busy={false} onGroupAction={noop}><li>x</li></AuthorBlock>)
    expect(ro).not.toContain('Mark all handled')
  })

  it('shows its comments when open', () => {
    const html = render('en', <AuthorBlock label="Aya" count={3} canWrite busy={false} defaultExpanded onGroupAction={noop}><li>inside</li></AuthorBlock>)
    expect(html).toContain('<li>inside</li>')
    expect(html).toContain('aria-expanded="true"')
  })

  it('names an author it does not know', () => {
    expect(render('en', <AuthorBlock label="" count={3} canWrite busy={false} onGroupAction={noop}><li>x</li></AuthorBlock>)).toContain('Unknown · 3 comments')
  })
})

describe('BulkBar', () => {
  for (const locale of LOCALES) {
    it(`counts the ticked comments and offers Mark handled, Spam and Hide, in ${locale}`, () => {
      const t = tr(locale)
      const html = render(locale, <BulkBar count={3} busy={false} onRun={noop} onClear={noop} />)
      expect(html).toContain(t('selectedCount', { count: 3 }))
      expect(html).toContain(t('markHandled'))
      expect(html).toContain(t('markSpam'))
      expect(html).toContain(t('hide'))
      expect(html).toContain(t('clearSelection'))
      // order on the bar: handled, spam, hide
      expect(html.indexOf(t('markHandled'))).toBeLessThan(html.indexOf(t('markSpam')))
      expect(html.indexOf(t('markSpam'))).toBeLessThan(html.lastIndexOf(t('hide')))
    })
  }

  it('is not there with nothing ticked', () => {
    expect(render('en', <BulkBar count={0} busy={false} onRun={noop} onClear={noop} />)).toBe('')
  })

  it('asks for confirmation before it hides', () => {
    const html = render('en', <BulkBar count={2} busy={false} onRun={noop} onClear={noop} initialConfirm="hide" />)
    expect(html).toContain('Hide 2 comments?')
    expect(html).toContain('Confirm')
  })

  it('turns its buttons off while it works', () => {
    const html = render('en', <BulkBar count={2} busy onRun={noop} onClear={noop} />)
    expect((html.match(/\sdisabled=""/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
