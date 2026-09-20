import { describe, it, expect } from 'vitest'
import type { TicketAttachment } from '@/types'
import {
  TICKET_FILE_MAX_BYTES,
  TICKET_MAX_ATTACHMENTS,
  checkTicketFile,
  formatBytes,
  isImageMime,
  splitAttachments,
} from './attachments'

describe('checkTicketFile', () => {
  it('accepts a normal file', () => {
    expect(checkTicketFile({ size: 1000, type: 'application/pdf' }, 0)).toBeNull()
  })
  it('refuses past the count cap', () => {
    expect(checkTicketFile({ size: 1, type: 'text/plain' }, TICKET_MAX_ATTACHMENTS)).toEqual({
      reason: 'tooMany',
      max: TICKET_MAX_ATTACHMENTS,
    })
  })
  it('refuses a non-image over the bucket limit', () => {
    expect(checkTicketFile({ size: TICKET_FILE_MAX_BYTES + 1, type: 'application/zip' }, 0)).toEqual({
      reason: 'tooLarge',
      maxBytes: TICKET_FILE_MAX_BYTES,
    })
  })
  it('leaves a big picture to be shrunk first', () => {
    expect(checkTicketFile({ size: 40 * 1024 * 1024, type: 'image/png' }, 0)).toBeNull()
  })
})

describe('formatBytes / isImageMime', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB')
  })
  it('recognises images by type', () => {
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('IMAGE/JPEG')).toBe(true)
    expect(isImageMime('application/pdf')).toBe(false)
    expect(isImageMime(null)).toBe(false)
  })
})

describe('splitAttachments', () => {
  const a = (id: string, mime_type: string, created_at: string) =>
    ({ id, mime_type, created_at }) as TicketAttachment
  it('separates pictures from files, each oldest first', () => {
    const { images, files } = splitAttachments([
      a('3', 'image/png', '2026-01-03'),
      a('1', 'application/pdf', '2026-01-01'),
      a('2', 'image/jpeg', '2026-01-02'),
    ])
    expect(images.map((x) => x.id)).toEqual(['2', '3'])
    expect(files.map((x) => x.id)).toEqual(['1'])
  })
})
