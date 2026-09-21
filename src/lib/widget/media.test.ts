import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  WIDGET_ALLOWED_MIME_TYPES,
  WIDGET_MAX_FILE_BYTES,
  WIDGET_MAX_VOICE_SECONDS,
  buildWidgetMediaPath,
  checkStoredObject,
  kindForMime,
  parseDeclaredMedia,
  sanitizeUploadFileName,
  widgetLimits,
} from './media'

const ACCOUNT = 'acc-1'
const CONV = 'conv-1'
const PREFIX = `account-${ACCOUNT}/widget/${CONV}/`

const good = (over: Record<string, unknown> = {}) => ({
  path: `${PREFIX}u-photo.jpg`,
  mimeType: 'image/jpeg',
  fileName: 'photo.jpg',
  sizeBytes: 1024,
  kind: 'image',
  ...over,
})

describe('the allow-list', () => {
  it('is exactly the chat-media bucket list from migration 023 (the bucket is not changed)', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/023_chat_media.sql'), 'utf8')
    const block = sql.slice(sql.indexOf('ARRAY['), sql.indexOf(']\n)', sql.indexOf('ARRAY[')))
    const inBucket = [...block.matchAll(/'([a-z]+\/[a-z0-9.+-]+)'/g)].map((m) => m[1]).sort()
    expect([...WIDGET_ALLOWED_MIME_TYPES].sort()).toEqual(inBucket)
    expect(16777216).toBe(WIDGET_MAX_FILE_BYTES)
  })

  it('is reported to the widget through limits', () => {
    expect(widgetLimits()).toEqual({
      maxFileBytes: 16 * 1024 * 1024,
      maxVoiceSeconds: 300,
      allowedMimeTypes: [...WIDGET_ALLOWED_MIME_TYPES],
    })
  })
})

describe('kindForMime', () => {
  it.each([
    ['image/png', 'image'],
    ['video/mp4', 'video'],
    ['audio/ogg; codecs=opus', 'audio'],
    ['application/pdf', 'document'],
    ['text/plain', 'document'],
  ])('%s -> %s', (mime, kind) => {
    expect(kindForMime(mime)).toBe(kind)
  })
})

describe('sanitizeUploadFileName / buildWidgetMediaPath', () => {
  it('strips separators and exotic characters, keeps the extension', () => {
    expect(sanitizeUploadFileName('../../etc/pass wd.PDF')).toBe('pass_wd.pdf')
    expect(sanitizeUploadFileName('My Résumé (final).docx')).toBe('My_R_sum_final.docx')
    expect(sanitizeUploadFileName('')).toBe('file')
  })

  it('builds a path under the conversation prefix', () => {
    expect(buildWidgetMediaPath(ACCOUNT, CONV, 'uuid1', 'a b.png')).toBe(`${PREFIX}uuid1-a_b.png`)
  })
})

describe('parseDeclaredMedia', () => {
  it('accepts a valid image', () => {
    const r = parseDeclaredMedia(good(), ACCOUNT, CONV)
    expect(r).toMatchObject({ ok: true, media: { kind: 'image', mimeType: 'image/jpeg', sizeBytes: 1024 } })
  })

  it('accepts a voice note within five minutes and records its rounded duration', () => {
    const r = parseDeclaredMedia(
      good({ mimeType: 'audio/ogg', kind: 'audio', fileName: 'v.ogg', path: `${PREFIX}u-v.ogg`, durationSeconds: 12.4 }),
      ACCOUNT,
      CONV,
    )
    expect(r).toMatchObject({ ok: true, media: { durationSeconds: 12 } })
  })

  it('rejects a voice note longer than five minutes as 413', () => {
    const r = parseDeclaredMedia(
      good({ mimeType: 'audio/ogg', kind: 'audio', path: `${PREFIX}u-v.ogg`, durationSeconds: WIDGET_MAX_VOICE_SECONDS + 1 }),
      ACCOUNT,
      CONV,
    )
    expect(r).toMatchObject({ ok: false, status: 413, code: 'file_too_large' })
  })

  it('rejects a path outside this conversation prefix (another visitor, another account, traversal)', () => {
    for (const path of [
      `account-other/widget/${CONV}/x.jpg`,
      `account-${ACCOUNT}/widget/conv-2/x.jpg`,
      `account-${ACCOUNT}/x.jpg`,
      `${PREFIX}../../x.jpg`,
      '',
    ]) {
      expect(parseDeclaredMedia(good({ path }), ACCOUNT, CONV)).toMatchObject({ ok: false, status: 400 })
    }
  })

  it('rejects a file over 16 MB as 413 file_too_large', () => {
    expect(parseDeclaredMedia(good({ sizeBytes: WIDGET_MAX_FILE_BYTES + 1 }), ACCOUNT, CONV)).toMatchObject({
      ok: false,
      status: 413,
      code: 'file_too_large',
    })
  })

  it('accepts exactly 16 MB', () => {
    expect(parseDeclaredMedia(good({ sizeBytes: WIDGET_MAX_FILE_BYTES }), ACCOUNT, CONV).ok).toBe(true)
  })

  it('rejects a type outside the allow-list as 415 file_type_not_allowed', () => {
    for (const mimeType of ['image/gif', 'application/x-msdownload', 'text/html', 'image/svg+xml', '']) {
      expect(parseDeclaredMedia(good({ mimeType }), ACCOUNT, CONV)).toMatchObject({
        ok: false,
        status: 415,
        code: 'file_type_not_allowed',
      })
    }
  })

  it('rejects a kind that does not match the type', () => {
    expect(parseDeclaredMedia(good({ kind: 'video' }), ACCOUNT, CONV)).toMatchObject({ ok: false, status: 400 })
    expect(parseDeclaredMedia(good({ kind: 'sticker' }), ACCOUNT, CONV)).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects missing or invalid basics', () => {
    expect(parseDeclaredMedia(null, ACCOUNT, CONV).ok).toBe(false)
    expect(parseDeclaredMedia(good({ fileName: '' }), ACCOUNT, CONV).ok).toBe(false)
    expect(parseDeclaredMedia(good({ sizeBytes: 0 }), ACCOUNT, CONV).ok).toBe(false)
    expect(parseDeclaredMedia(good({ sizeBytes: '10' }), ACCOUNT, CONV).ok).toBe(false)
    expect(parseDeclaredMedia(good({ durationSeconds: -1 }), ACCOUNT, CONV).ok).toBe(false)
  })
})

describe('checkStoredObject (what Storage really holds vs what was declared)', () => {
  const declared = () => {
    const r = parseDeclaredMedia(good(), ACCOUNT, CONV)
    if (!r.ok) throw new Error('setup')
    return r.media
  }

  it('accepts a matching object', () => {
    expect(checkStoredObject(declared(), { size: 1024, contentType: 'image/jpeg' })).toEqual({ ok: true })
  })

  it('compares the base content type (parameters ignored)', () => {
    expect(checkStoredObject(declared(), { size: 1024, contentType: 'image/jpeg; charset=binary' }).ok).toBe(true)
  })

  it('rejects an object bigger than 16 MB as 413', () => {
    expect(checkStoredObject(declared(), { size: WIDGET_MAX_FILE_BYTES + 1, contentType: 'image/jpeg' })).toMatchObject({
      ok: false,
      status: 413,
    })
  })

  it('rejects an object whose real type is not allowed as 415', () => {
    expect(checkStoredObject(declared(), { size: 1024, contentType: 'text/html' })).toMatchObject({ ok: false, status: 415 })
  })

  it('rejects a real type that differs from the declared one as 415', () => {
    expect(checkStoredObject(declared(), { size: 1024, contentType: 'application/pdf' })).toMatchObject({
      ok: false,
      status: 415,
    })
  })

  it('rejects a size that differs from the declared one as 413', () => {
    expect(checkStoredObject(declared(), { size: 2048, contentType: 'image/jpeg' })).toMatchObject({ ok: false, status: 413 })
  })

  it('rejects an unreadable object', () => {
    expect(checkStoredObject(declared(), { contentType: 'image/jpeg' })).toMatchObject({ ok: false, status: 400 })
  })
})
