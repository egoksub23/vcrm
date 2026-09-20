import { describe, it, expect } from 'vitest'
import {
  cleanFileName,
  isOwnStoragePath,
  parseStagedAttachments,
  planAttachmentChanges,
} from './attachments-input'
import { KB_MAX_ATTACHMENTS } from '@/lib/knowledge-types'

const ACCT = '11111111-2222-3333-4444-555555555555'
const ID_A = '0f8fad5b-d9cb-469f-a165-70867728950e'
const ID_B = '1f8fad5b-d9cb-469f-a165-70867728950e'

const file = (over: Record<string, unknown> = {}) => ({
  file_name: 'menu.pdf',
  mime_type: 'application/pdf',
  size_bytes: 1000,
  url: 'https://x.supabase.co/storage/v1/object/public/chat-media/account-' + ACCT + '/kb/1-menu.pdf',
  storage_path: `account-${ACCT}/kb/1-menu.pdf`,
  send_with_ai: true,
  ...over,
})

describe('isOwnStoragePath', () => {
  it('accepts paths under the account folder', () => {
    expect(isOwnStoragePath(`account-${ACCT}/kb/a.pdf`, ACCT)).toBe(true)
  })
  it('rejects another account, traversal, empty and odd paths', () => {
    expect(isOwnStoragePath('account-other/kb/a.pdf', ACCT)).toBe(false)
    expect(isOwnStoragePath(`account-${ACCT}/../account-x/a.pdf`, ACCT)).toBe(false)
    expect(isOwnStoragePath(`account-${ACCT}/`, ACCT)).toBe(false)
    expect(isOwnStoragePath(`account-${ACCT}//a.pdf`, ACCT)).toBe(false)
    expect(isOwnStoragePath(`account-${ACCT}\\a.pdf`, ACCT)).toBe(false)
    expect(isOwnStoragePath(`/account-${ACCT}/a.pdf`, ACCT)).toBe(false)
    expect(isOwnStoragePath(`account-${ACCT}/a\nb.pdf`, ACCT)).toBe(false)
    expect(isOwnStoragePath(`account-${ACCT}x/a.pdf`, ACCT)).toBe(false)
  })
})

describe('cleanFileName', () => {
  it('removes path parts and control characters', () => {
    expect(cleanFileName('  ../../etc/pass\nwd.pdf ')).toBe('.._.._etc_passwd.pdf')
    expect(cleanFileName('a'.repeat(300)).length).toBe(200)
  })
})

describe('parseStagedAttachments', () => {
  it('accepts a new file and derives nothing from the client', () => {
    const r = parseStagedAttachments([file({ mime_type: 'Application/PDF' })], ACCT)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.items).toHaveLength(1)
      expect(r.items[0]).toMatchObject({ file_name: 'menu.pdf', mime_type: 'application/pdf', send_with_ai: true })
      expect(r.items[0].id).toBeUndefined()
    }
  })

  it('defaults send_with_ai to true and mime to octet-stream', () => {
    const r = parseStagedAttachments([file({ send_with_ai: undefined, mime_type: '' })], ACCT)
    expect(r.ok && r.items[0]).toMatchObject({ send_with_ai: true, mime_type: 'application/octet-stream' })
  })

  it('keeps an existing attachment by id, honouring only the switch', () => {
    const r = parseStagedAttachments([{ id: ID_A, send_with_ai: false }], ACCT)
    expect(r).toEqual({
      ok: true,
      items: [{ id: ID_A, file_name: '', mime_type: '', size_bytes: 0, url: '', storage_path: '', send_with_ai: false }],
    })
  })

  it('rejects a path in another account', () => {
    const r = parseStagedAttachments([file({ storage_path: 'account-someone-else/kb/x.pdf' })], ACCT)
    expect(r.ok).toBe(false)
  })

  it('applies the per-kind size caps (5 MB images, 16 MB other)', () => {
    expect(parseStagedAttachments([file({ mime_type: 'image/png', size_bytes: 5 * 1024 * 1024 + 1 })], ACCT).ok).toBe(false)
    expect(parseStagedAttachments([file({ mime_type: 'image/png', size_bytes: 5 * 1024 * 1024 })], ACCT).ok).toBe(true)
    expect(parseStagedAttachments([file({ size_bytes: 16 * 1024 * 1024 + 1 })], ACCT).ok).toBe(false)
    expect(parseStagedAttachments([file({ size_bytes: 16 * 1024 * 1024 })], ACCT).ok).toBe(true)
  })

  it('caps the number of attachments', () => {
    const many = Array.from({ length: KB_MAX_ATTACHMENTS + 1 }, (_, i) =>
      file({ storage_path: `account-${ACCT}/kb/${i}.pdf`, file_name: `f${i}.pdf` }),
    )
    expect(parseStagedAttachments(many, ACCT).ok).toBe(false)
    expect(parseStagedAttachments(many.slice(0, KB_MAX_ATTACHMENTS), ACCT).ok).toBe(true)
  })

  it.each([
    ['not a list', 'x'],
    ['a non-object entry', [5]],
    ['a missing name', [file({ file_name: '   ' })]],
    ['a bad size', [file({ size_bytes: -1 })]],
    ['a NaN size', [file({ size_bytes: Number.NaN })]],
    ['a non-http url', [file({ url: 'javascript:alert(1)' })]],
    ['a missing url', [file({ url: undefined })]],
    ['a bad id', [{ id: 'nope', send_with_ai: true }]],
    ['a non-boolean switch', [file({ send_with_ai: 'yes' })]],
    ['a duplicate id', [{ id: ID_A }, { id: ID_A }]],
    ['a duplicate path', [file(), file()]],
  ])('rejects %s', (_label, value) => {
    expect(parseStagedAttachments(value, ACCT).ok).toBe(false)
  })
})

describe('planAttachmentChanges', () => {
  it('keeps, adds and removes by id, and orders by list position', () => {
    const staged = [
      { file_name: 'new.pdf', mime_type: 'application/pdf', size_bytes: 1, url: 'https://x/n', storage_path: 'p', send_with_ai: true },
      { id: ID_B, file_name: '', mime_type: '', size_bytes: 0, url: '', storage_path: '', send_with_ai: false },
    ]
    const plan = planAttachmentChanges([ID_A, ID_B], staged)
    expect(plan.keep).toEqual([{ id: ID_B, position: 1, send_with_ai: false }])
    expect(plan.add).toHaveLength(1)
    expect(plan.add[0]).toMatchObject({ file_name: 'new.pdf', position: 0 })
    expect(plan.removeIds).toEqual([ID_A])
    expect(plan.unknownIds).toEqual([])
  })

  it('an empty list removes everything', () => {
    expect(planAttachmentChanges([ID_A, ID_B], []).removeIds).toEqual([ID_A, ID_B])
  })

  it('reports ids that are not this article\'s attachments', () => {
    const plan = planAttachmentChanges([ID_A], [
      { id: ID_B, file_name: '', mime_type: '', size_bytes: 0, url: '', storage_path: '', send_with_ai: true },
    ])
    expect(plan.unknownIds).toEqual([ID_B])
    expect(plan.removeIds).toEqual([ID_A])
  })
})
