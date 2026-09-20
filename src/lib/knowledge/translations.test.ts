import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeDb } from '@/lib/comments/fake-db'

vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: vi.fn() }))

import { loadSendableAttachments } from './attachments'
import { keepTranslationsCurrent, loadEffectiveAttachments } from './translations'

const ACCT = 'acct'

const file = (id: string, documentId: string, over: Record<string, unknown> = {}) => ({
  id,
  account_id: ACCT,
  document_id: documentId,
  file_name: `${id}.pdf`,
  mime_type: 'application/pdf',
  size_bytes: 10,
  kind: 'document',
  storage_path: `account-${ACCT}/kb/${id}.pdf`,
  public_url: `https://cdn/${id}.pdf`,
  send_with_ai: true,
  position: 0,
  ...over,
})

const docs = [
  { id: 'base', account_id: ACCT, translation_of: null },
  { id: 'ms', account_id: ACCT, translation_of: 'base' },
  { id: 'zh', account_id: ACCT, translation_of: 'base' },
  { id: 'solo', account_id: ACCT, translation_of: null },
]

const ids = (m: Map<string, { id: string }[]>) => Object.fromEntries([...m].map(([k, v]) => [k, v.map((f) => f.id)]))

describe('loadEffectiveAttachments', () => {
  it('gives a translation with no files of its own its base files', async () => {
    const { db } = makeFakeDb({
      ai_knowledge_documents: docs,
      knowledge_attachments: [file('f1', 'base'), file('f2', 'base', { position: 1 })],
    })
    expect(ids(await loadEffectiveAttachments(db, ACCT, ['ms']))).toEqual({ ms: ['f1', 'f2'] })
  })

  it('gives a translation with files of its own only those', async () => {
    const { db } = makeFakeDb({
      ai_knowledge_documents: docs,
      knowledge_attachments: [file('f1', 'base'), file('z1', 'zh')],
    })
    expect(ids(await loadEffectiveAttachments(db, ACCT, ['zh', 'ms']))).toEqual({ zh: ['z1'] })
  })

  it('sends a group once: a base and its translations never both contribute', async () => {
    const { db } = makeFakeDb({
      ai_knowledge_documents: docs,
      knowledge_attachments: [file('f1', 'base'), file('z1', 'zh'), file('s1', 'solo')],
    })
    // the Malay article first, then its base and the Chinese one: only Malay (=> base files) and solo
    expect(ids(await loadEffectiveAttachments(db, ACCT, ['ms', 'base', 'zh', 'solo']))).toEqual({ ms: ['f1'], solo: ['s1'] })
  })

  it('reads another account never: files are looked up for this account only', async () => {
    const { db } = makeFakeDb({
      ai_knowledge_documents: docs,
      knowledge_attachments: [file('x1', 'base', { account_id: 'other' })],
    })
    expect(ids(await loadEffectiveAttachments(db, ACCT, ['ms']))).toEqual({ ms: [] })
  })

  it('returns nothing without articles', async () => {
    const { db } = makeFakeDb()
    expect((await loadEffectiveAttachments(db, ACCT, [])).size).toBe(0)
  })

  it('falls back to each article own files when the translation links cannot be read', async () => {
    const fake = makeFakeDb({ knowledge_attachments: [file('f1', 'base'), file('s1', 'ms')] })
    const db = {
      from: (t: string) => {
        if (t !== 'ai_knowledge_documents') return fake.db.from(t)
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'in']) chain[m] = () => chain
        chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'down' } })
        return chain
      },
    } as unknown as SupabaseClient
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(ids(await loadEffectiveAttachments(db, ACCT, ['ms']))).toEqual({ ms: ['s1'] })
    spy.mockRestore()
  })
})

describe('loadSendableAttachments with translations', () => {
  it('sends the base files for a translation, honouring the send switch', async () => {
    const { db } = makeFakeDb({
      ai_knowledge_documents: docs,
      knowledge_attachments: [file('on', 'base'), file('off', 'base', { send_with_ai: false, position: 1 })],
    })
    expect((await loadSendableAttachments(db, ACCT, ['ms'])).map((f) => f.id)).toEqual(['on'])
  })

  it('does not fall back to the base when the translation own files are switched off', async () => {
    const { db } = makeFakeDb({
      ai_knowledge_documents: docs,
      knowledge_attachments: [file('base1', 'base'), file('own-off', 'ms', { send_with_ai: false })],
    })
    expect(await loadSendableAttachments(db, ACCT, ['ms'])).toEqual([])
  })

  it('skips a translation sibling of an article already cited', async () => {
    const { db } = makeFakeDb({
      ai_knowledge_documents: docs,
      knowledge_attachments: [file('f1', 'base'), file('z1', 'zh')],
    })
    expect((await loadSendableAttachments(db, ACCT, ['base', 'zh'])).map((f) => f.id)).toEqual(['f1'])
  })

  it('keeps the order of the cited articles', async () => {
    const { db } = makeFakeDb({
      ai_knowledge_documents: docs,
      knowledge_attachments: [file('s1', 'solo'), file('f1', 'base')],
    })
    expect((await loadSendableAttachments(db, ACCT, ['solo', 'ms'])).map((f) => f.id)).toEqual(['s1', 'f1'])
  })
})

describe('keepTranslationsCurrent', () => {
  function recorder() {
    const calls: [string, unknown[]][] = []
    const chain: Record<string, unknown> = {}
    for (const m of ['update', 'eq', 'gte']) {
      chain[m] = (...a: unknown[]) => {
        calls.push([m, a])
        return chain
      }
    }
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
    const db = { from: () => chain } as unknown as SupabaseClient
    return { db, calls }
  }

  it('moves only the translations that were current forward', async () => {
    const { db, calls } = recorder()
    await keepTranslationsCurrent(db, ACCT, 'base', '2026-09-20T10:00:00+00:00', '2026-09-20T11:00:00+00:00')
    expect(calls).toEqual([
      ['update', [{ translated_from_at: '2026-09-20T11:00:00+00:00' }]],
      ['eq', ['account_id', ACCT]],
      ['eq', ['translation_of', 'base']],
      ['gte', ['translated_from_at', '2026-09-20T10:00:00+00:00']],
    ])
  })

  it('does nothing when the base did not move', async () => {
    const { db, calls } = recorder()
    await keepTranslationsCurrent(db, ACCT, 'base', '2026-09-20T10:00:00+00:00', '2026-09-20T10:00:00+00:00')
    expect(calls).toEqual([])
  })

  it('never throws', async () => {
    const db = {
      from: () => {
        throw new Error('down')
      },
    } as unknown as SupabaseClient
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(keepTranslationsCurrent(db, ACCT, 'b', 'a', 'c')).resolves.toBeUndefined()
    spy.mockRestore()
  })
})
