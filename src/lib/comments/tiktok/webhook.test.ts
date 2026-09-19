import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { parseTikTokCommentEvent, quoteBigIds, verifyTikTokSignature } from './webhook'

const SECRET = 'app-secret'
const NOW = 1_700_000_000

const sign = (body: string, t = NOW, secret = SECRET) =>
  `t=${t},s=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`

// A real-shaped delivery: `content` is a STRINGIFIED JSON with 19-digit ids.
const CONTENT =
  '{"comment_id":7247303576418566913,"video_id":7203946942097902849,"parent_comment_id":7235861947622916866,"comment_type":"reply","comment_action":"insert","unique_identifier":"abc+/=","timestamp":1687394416109,"text":"How much?"}'
const BODY = JSON.stringify({
  client_key: 'key',
  event: 'comment.update',
  create_time: 1615338610,
  user_openid: 'open-123',
  content: CONTENT,
})

describe('verifyTikTokSignature', () => {
  it('accepts a correct signature', () => {
    expect(verifyTikTokSignature({ rawBody: BODY, header: sign(BODY), secret: SECRET, nowSeconds: NOW })).toBe(true)
  })
  it('rejects a body that was changed', () => {
    expect(verifyTikTokSignature({ rawBody: BODY + ' ', header: sign(BODY), secret: SECRET, nowSeconds: NOW })).toBe(false)
  })
  it('rejects the wrong secret', () => {
    expect(verifyTikTokSignature({ rawBody: BODY, header: sign(BODY, NOW, 'other'), secret: SECRET, nowSeconds: NOW })).toBe(false)
  })
  it('rejects an old timestamp (replay)', () => {
    expect(verifyTikTokSignature({ rawBody: BODY, header: sign(BODY, NOW - 3600), secret: SECRET, nowSeconds: NOW })).toBe(false)
  })
  it.each([null, '', 'garbage', 't=abc,s=zz', `t=${NOW}`, 's=abcd'])('rejects a malformed header %j', (header) => {
    expect(verifyTikTokSignature({ rawBody: BODY, header, secret: SECRET, nowSeconds: NOW })).toBe(false)
  })
})

describe('quoteBigIds', () => {
  it('quotes ids in plain JSON', () => {
    expect(quoteBigIds('{"comment_id": 7247303576418566913}')).toBe('{"comment_id":"7247303576418566913"}')
  })
  it('quotes ids inside a stringified content field', () => {
    expect(quoteBigIds(BODY)).toContain('\\"comment_id\\":\\"7247303576418566913\\"')
  })
})

describe('parseTikTokCommentEvent', () => {
  it('keeps 19-digit ids exact (JSON.parse alone would round them)', () => {
    // Prove the trap is real, so this test guards something.
    expect(String(JSON.parse(CONTENT).comment_id)).not.toBe('7247303576418566913')

    const e = parseTikTokCommentEvent(BODY)!
    expect(e.commentId).toBe('7247303576418566913')
    expect(e.videoId).toBe('7203946942097902849')
    expect(e.parentCommentId).toBe('7235861947622916866')
  })

  it('reads the rest of the event', () => {
    expect(parseTikTokCommentEvent(BODY)).toMatchObject({
      userOpenId: 'open-123',
      commentType: 'reply',
      action: 'insert',
      uniqueIdentifier: 'abc+/=',
      text: 'How much?',
      timestamp: 1687394416109,
    })
  })

  it('handles a top-level comment with no parent', () => {
    const body = JSON.stringify({
      event: 'comment.update',
      user_openid: 'o',
      content: '{"comment_id":7247303576418566913,"video_id":7203946942097902849,"comment_type":"comment","comment_action":"delete","timestamp":1}',
    })
    const e = parseTikTokCommentEvent(body)!
    expect(e.parentCommentId).toBeNull()
    expect(e.action).toBe('delete')
  })

  it('accepts content sent as an object', () => {
    const body =
      '{"event":"comment.update","user_openid":"o","content":{"comment_id":7247303576418566913,"video_id":7203946942097902849,"timestamp":5}}'
    expect(parseTikTokCommentEvent(body)?.commentId).toBe('7247303576418566913')
  })

  it.each([
    ['another event', JSON.stringify({ event: 'video.publish', user_openid: 'o', content: '{}' })],
    ['not JSON', 'nope'],
    ['no tenant', JSON.stringify({ event: 'comment.update', content: CONTENT })],
    ['no ids', JSON.stringify({ event: 'comment.update', user_openid: 'o', content: '{"text":"x"}' })],
    ['bad content', JSON.stringify({ event: 'comment.update', user_openid: 'o', content: '{oops' })],
  ])('returns null for %s', (_n, body) => {
    expect(parseTikTokCommentEvent(body)).toBeNull()
  })
})
