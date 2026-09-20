import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeDb } from '@/lib/comments/fake-db'
import { AiError } from '@/lib/ai/types'

const h = vi.hoisted(() => ({ generateReply: vi.fn() }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (s: string) => {
    if (s === 'BAD') throw new Error('bad ciphertext')
    return `dec:${s}`
  },
}))

import { handleTranslate, type TranslateContext } from './translate-run'

const ACCT = 'acct-1'
const ADMIN = 'user-admin'
const AGENT = 'user-agent'
const OTHER = 'user-other'

const aiConfig = {
  account_id: ACCT, provider: 'openai', base_url: null, model: 'gpt-x', api_key: 'enc', system_prompt: null,
  is_active: true, auto_reply_enabled: false, auto_reply_max_per_conversation: 3, handoff_agent_id: null,
  embeddings_api_key: null, embeddings_base_url: null, embeddings_model: null, monthly_token_budget: null,
}

const baseArticle = (over: Record<string, unknown> = {}) => ({
  id: 'base',
  account_id: ACCT,
  title: 'Refund policy',
  content: 'Refunds within 14 days. Price RM 25.00.',
  content_html: '<p>Refunds within <strong>14</strong> days. Price RM 25.00.</p>',
  language: 'en',
  status: 'published',
  created_by: ADMIN,
  kind: 'article',
  use_in_ai: false,
  review_by: '2027-01-01',
  collection_id: 'coll-1',
  translation_of: null,
  updated_at: '2026-09-20T10:00:00.123456+00:00',
  ...over,
})

const modelAnswer = (o: { title?: string; content_html?: string } = {}) => ({
  text: JSON.stringify({
    title: o.title ?? 'Polisi bayaran balik',
    content_html: o.content_html ?? '<p>Bayaran balik dalam <strong>14</strong> hari. Harga RM 25.00.</p>',
  }),
  handoff: false,
  usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
})

function setup(seed: Record<string, Record<string, unknown>[]> = {}, who: { userId?: string; isAdmin?: boolean } = {}) {
  const user = makeFakeDb({ ai_configs: [aiConfig], ai_knowledge_documents: [baseArticle()], ...seed })
  const admin = makeFakeDb()
  const ctx: TranslateContext = {
    db: user.db,
    admin: admin.db,
    accountId: ACCT,
    userId: who.userId ?? ADMIN,
    isAdmin: who.isAdmin ?? true,
  }
  const docs = () => user.tables.ai_knowledge_documents
  const translations = () => docs().filter((d) => d.translation_of)
  return { user, admin, ctx, docs, translations }
}

beforeEach(() => {
  h.generateReply.mockReset()
  h.generateReply.mockResolvedValue(modelAnswer())
})

describe('handleTranslate: a new translation', () => {
  it('saves a machine-translated DRAFT linked to the base and never indexes it', async () => {
    const { ctx, translations, user, admin } = setup()
    const r = await handleTranslate(ctx, 'base', { language: 'ms' })

    expect(r.status).toBe(200)
    expect(r.body.results).toHaveLength(1)
    expect(r.body.results[0]).toMatchObject({ language: 'ms', ok: true, overwritten: false })

    const [t] = translations()
    expect(t).toMatchObject({
      id: r.body.results[0].id,
      account_id: ACCT,
      title: 'Polisi bayaran balik',
      content: 'Bayaran balik dalam 14 hari. Harga RM 25.00.',
      content_html: '<p>Bayaran balik dalam <strong>14</strong> hari. Harga RM 25.00.</p>',
      language: 'ms',
      status: 'draft',
      machine_translated: true,
      translation_of: 'base',
      translated_from_at: '2026-09-20T10:00:00.123456+00:00',
      created_by: ADMIN,
      // inherited from the base
      kind: 'article',
      use_in_ai: false,
      review_by: '2027-01-01',
      collection_id: 'coll-1',
    })
    // a draft is never indexed
    expect(user.tables.ai_knowledge_chunks ?? []).toHaveLength(0)
    expect(user.rpcCalls).toHaveLength(0)

    // spend is logged under the translate job
    expect(admin.tables.ai_usage_log).toHaveLength(1)
    expect(admin.tables.ai_usage_log[0]).toMatchObject({ account_id: ACCT, mode: 'translate', provider: 'openai', model: 'gpt-x', total_tokens: 150 })
  })

  it('asks the model for the right languages with the budget guard and a roomy reply', async () => {
    const { ctx, admin } = setup()
    await handleTranslate(ctx, 'base', { language: 'zh' })
    const args = h.generateReply.mock.calls[0][0]
    expect(args.systemPrompt).toContain('from English into Chinese')
    expect(args.guard).toEqual({ db: admin.db, accountId: ACCT })
    expect(args.maxOutputTokens).toBeGreaterThan(1024)
    expect(args.timeoutMs).toBeGreaterThanOrEqual(120_000)
    expect(args.messages).toHaveLength(1)
    expect(args.messages[0].content).toContain('Refund policy')
    expect(args.messages[0].content).toContain('<strong>14</strong>')
  })

  it('wraps plain text in paragraphs when the article has no rich text', async () => {
    const { ctx } = setup({ ai_knowledge_documents: [baseArticle({ content_html: null, content: 'Line one.\n\nLine two.' })] })
    await handleTranslate(ctx, 'base', { language: 'ms' })
    const sent = h.generateReply.mock.calls[0][0].messages[0].content as string
    expect(JSON.parse(sent.slice(sent.indexOf('{'))).content_html).toBe('<p>Line one.</p><p>Line two.</p>')
  })

  it('accepts a fenced JSON answer', async () => {
    h.generateReply.mockResolvedValue({
      ...modelAnswer(),
      text: '```json\n' + modelAnswer().text + '\n```',
    })
    const { ctx, translations } = setup()
    const r = await handleTranslate(ctx, 'base', { language: 'ms' })
    expect(r.status).toBe(200)
    expect(translations()).toHaveLength(1)
  })

  it('removes script tags and handlers from what the model wrote', async () => {
    h.generateReply.mockResolvedValue(
      modelAnswer({ content_html: '<p onclick="x()">Halo</p><script>alert(1)</script><a href="javascript:evil()">klik</a>' }),
    )
    const { ctx, translations } = setup()
    const r = await handleTranslate(ctx, 'base', { language: 'ms' })
    expect(r.status).toBe(200)
    const [t] = translations()
    expect(String(t.content_html)).not.toMatch(/script|onclick|javascript:/i)
    expect(String(t.content)).not.toContain('alert')
  })

  it('refuses a bad answer with 502, saves nothing, but still logs the spend', async () => {
    h.generateReply.mockResolvedValue({ text: 'Sorry, I cannot translate that.', handoff: false, usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } })
    const { ctx, translations, admin } = setup()
    const r = await handleTranslate(ctx, 'base', { language: 'ms' })
    expect(r.status).toBe(502)
    expect(r.body).toMatchObject({ code: 'bad_model_output' })
    expect(r.body.results[0]).toMatchObject({ language: 'ms', ok: false, code: 'bad_model_output' })
    expect(translations()).toHaveLength(0)
    expect(admin.tables.ai_usage_log).toHaveLength(1)
  })

  it('refuses a translation that comes back empty after cleaning', async () => {
    h.generateReply.mockResolvedValue(modelAnswer({ content_html: '<script>alert(1)</script>' }))
    const { ctx, translations } = setup()
    const r = await handleTranslate(ctx, 'base', { language: 'ms' })
    expect(r.status).toBe(502)
    expect(translations()).toHaveLength(0)
  })

  it('passes a spent budget through as the typed 429', async () => {
    h.generateReply.mockRejectedValue(new AiError('The monthly AI token budget has been used up.', { code: 'budget_exceeded', status: 429 }))
    const { ctx, translations } = setup()
    const r = await handleTranslate(ctx, 'base', { language: 'ms' })
    expect(r.status).toBe(429)
    expect(r.body).toMatchObject({ code: 'budget_exceeded' })
    expect(translations()).toHaveLength(0)
  })

  it('reports a provider failure with its own status', async () => {
    h.generateReply.mockRejectedValue(new AiError('The AI provider took too long to respond.', { code: 'timeout', status: 504 }))
    const { ctx } = setup()
    const r = await handleTranslate(ctx, 'base', { language: 'ms' })
    expect(r.status).toBe(504)
    expect(r.body.code).toBe('timeout')
  })

  it('refuses an article too long to translate in one go, without calling the model', async () => {
    const { ctx } = setup({ ai_knowledge_documents: [baseArticle({ content_html: '<p>' + 'a'.repeat(61_000) + '</p>' })] })
    const r = await handleTranslate(ctx, 'base', { language: 'ms' })
    expect(r.status).toBe(422)
    expect(r.body.code).toBe('too_long')
    expect(h.generateReply).not.toHaveBeenCalled()
  })
})

describe('handleTranslate: AI setup', () => {
  it('answers 400 pointing at AI Agents → Setup when no AI is configured', async () => {
    const { ctx } = setup({ ai_configs: [] })
    const r = await handleTranslate(ctx, 'base', { language: 'ms' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('ai_not_configured')
    expect(r.body.error).toMatch(/AI Agents/)
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('treats a switched-off translate job the same way', async () => {
    const { ctx } = setup({ ai_task_routing: [{ account_id: ACCT, task: 'translate', connection_id: null, model_override: null, enabled: false }] })
    const r = await handleTranslate(ctx, 'base', { language: 'ms' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('ai_not_configured')
  })

  it('uses the connection and model the translate job is routed to, and a deleted connection falls back to the default', async () => {
    const routed = setup({
      ai_connections: [{ id: 'conn-1', account_id: ACCT, provider: 'anthropic', base_url: null, model: 'claude-x', api_key: 'enc-c' }],
      ai_task_routing: [{ account_id: ACCT, task: 'translate', connection_id: 'conn-1', model_override: 'claude-big', enabled: true }],
    })
    await handleTranslate(routed.ctx, 'base', { language: 'ms' })
    expect(h.generateReply.mock.calls[0][0].config).toMatchObject({ provider: 'anthropic', model: 'claude-big', apiKey: 'dec:enc-c', connectionId: 'conn-1' })
    expect(routed.admin.tables.ai_usage_log[0]).toMatchObject({ connection_id: 'conn-1', mode: 'translate' })

    h.generateReply.mockClear()
    const gone = setup({
      ai_task_routing: [{ account_id: ACCT, task: 'translate', connection_id: 'deleted', model_override: null, enabled: true }],
    })
    const r = await handleTranslate(gone.ctx, 'base', { language: 'ms' })
    expect(r.status).toBe(200)
    expect(h.generateReply.mock.calls[0][0].config).toMatchObject({ provider: 'openai', model: 'gpt-x', connectionId: null })
  })

  it('tells apart a key that cannot be decrypted', async () => {
    const { ctx } = setup({ ai_configs: [{ ...aiConfig, api_key: 'BAD' }] })
    const r = await handleTranslate(ctx, 'base', { language: 'ms' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('key_decrypt_failed')
  })
})

describe('handleTranslate: what may be translated', () => {
  it('404s an unknown article and one from another account', async () => {
    const { ctx } = setup({ ai_knowledge_documents: [baseArticle({ account_id: 'someone-else' })] })
    expect((await handleTranslate(ctx, 'nope', { language: 'ms' })).status).toBe(404)
    expect((await handleTranslate(ctx, 'base', { language: 'ms' })).status).toBe(404)
  })

  it('refuses to translate a translation (no chains)', async () => {
    const { ctx, translations } = setup({
      ai_knowledge_documents: [baseArticle(), baseArticle({ id: 'ms1', language: 'ms', translation_of: 'base', machine_translated: true })],
    })
    const r = await handleTranslate(ctx, 'ms1', { language: 'zh' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('translation_of_translation')
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(translations()).toHaveLength(1)
  })

  it('refuses the base language and unknown languages', async () => {
    const { ctx } = setup()
    expect((await handleTranslate(ctx, 'base', { language: 'en' })).body.code).toBe('same_language')
    expect((await handleTranslate(ctx, 'base', { language: 'ko' })).body.code).toBe('invalid_language')
    expect((await handleTranslate(ctx, 'base', {})).status).toBe(400)
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('lets an agent translate their own draft, but not someone else draft or a published article', async () => {
    const own = setup({ ai_knowledge_documents: [baseArticle({ status: 'draft', created_by: AGENT })] }, { userId: AGENT, isAdmin: false })
    const ok = await handleTranslate(own.ctx, 'base', { language: 'ms' })
    expect(ok.status).toBe(200)
    // the result is the agent's own draft
    expect(own.translations()[0]).toMatchObject({ created_by: AGENT, status: 'draft' })

    const theirs = setup({ ai_knowledge_documents: [baseArticle({ status: 'draft', created_by: OTHER })] }, { userId: AGENT, isAdmin: false })
    expect((await handleTranslate(theirs.ctx, 'base', { language: 'ms' })).status).toBe(403)

    const live = setup({ ai_knowledge_documents: [baseArticle({ status: 'published', created_by: AGENT })] }, { userId: AGENT, isAdmin: false })
    expect((await handleTranslate(live.ctx, 'base', { language: 'ms' })).status).toBe(403)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
  })

  it('lets an admin translate a published article from someone else', async () => {
    const { ctx } = setup({ ai_knowledge_documents: [baseArticle({ status: 'published', created_by: OTHER })] })
    expect((await handleTranslate(ctx, 'base', { language: 'ms' })).status).toBe(200)
  })
})

describe('handleTranslate: an existing translation', () => {
  const existing = (over: Record<string, unknown> = {}) =>
    baseArticle({
      id: 'ms1',
      title: 'My hand edits',
      content: 'edited',
      content_html: '<p>edited</p>',
      language: 'ms',
      status: 'published',
      translation_of: 'base',
      machine_translated: false,
      translated_from_at: '2026-09-01T00:00:00Z',
      ...over,
    })

  it('answers 409 without calling the model, and leaves the hand edits alone', async () => {
    const { ctx, docs } = setup({ ai_knowledge_documents: [baseArticle(), existing()] })
    const r = await handleTranslate(ctx, 'base', { language: 'ms' })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('translation_exists')
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(docs().find((d) => d.id === 'ms1')).toMatchObject({ title: 'My hand edits' })
  })

  it('replaces it only with overwrite, back to a machine-translated draft', async () => {
    const { ctx, docs, translations } = setup({ ai_knowledge_documents: [baseArticle(), existing()] })
    const r = await handleTranslate(ctx, 'base', { language: 'ms', overwrite: true })
    expect(r.status).toBe(200)
    expect(r.body.results[0]).toMatchObject({ ok: true, overwritten: true, id: 'ms1' })
    expect(translations()).toHaveLength(1)
    expect(docs().find((d) => d.id === 'ms1')).toMatchObject({
      title: 'Polisi bayaran balik',
      status: 'draft',
      machine_translated: true,
      translated_from_at: '2026-09-20T10:00:00.123456+00:00',
      updated_by: ADMIN,
    })
  })

  it('does not let an agent replace a translation that is not their own draft', async () => {
    const { ctx } = setup(
      { ai_knowledge_documents: [baseArticle({ status: 'draft', created_by: AGENT }), existing({ status: 'draft', created_by: ADMIN })] },
      { userId: AGENT, isAdmin: false },
    )
    const r = await handleTranslate(ctx, 'base', { language: 'ms', overwrite: true })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('forbidden')
    expect(h.generateReply).not.toHaveBeenCalled()
  })
})

describe('handleTranslate: several languages at once', () => {
  it('translates each in turn and returns a result per language', async () => {
    h.generateReply
      .mockResolvedValueOnce(modelAnswer({ title: 'Polisi' }))
      .mockResolvedValueOnce(modelAnswer({ title: '退款政策', content_html: '<p>14天内可退款。</p>' }))
    const { ctx, translations } = setup()
    const r = await handleTranslate(ctx, 'base', { languages: ['ms', 'zh'] })
    expect(r.status).toBe(200)
    expect(r.body.results.map((x) => [x.language, x.ok])).toEqual([['ms', true], ['zh', true]])
    expect(translations().map((t) => t.language).sort()).toEqual(['ms', 'zh'])
  })

  it('one failure does not lose the others', async () => {
    h.generateReply
      .mockResolvedValueOnce(modelAnswer({ title: 'Polisi' }))
      .mockResolvedValueOnce({ text: 'no', handoff: false, usage: null })
    const { ctx, translations } = setup()
    const r = await handleTranslate(ctx, 'base', { languages: ['ms', 'zh'] })
    expect(r.status).toBe(200)
    expect(r.body.results).toMatchObject([{ language: 'ms', ok: true }, { language: 'zh', ok: false, code: 'bad_model_output' }])
    expect(translations()).toHaveLength(1)
  })

  it('reports an already existing language and translates the rest', async () => {
    const { ctx } = setup({
      ai_knowledge_documents: [baseArticle(), baseArticle({ id: 'ms1', language: 'ms', translation_of: 'base', status: 'draft' })],
    })
    const r = await handleTranslate(ctx, 'base', { languages: ['ms', 'zh'] })
    expect(r.status).toBe(200)
    expect(r.body.results).toMatchObject([{ language: 'ms', ok: false, code: 'translation_exists' }, { language: 'zh', ok: true }])
    expect(h.generateReply).toHaveBeenCalledTimes(1)
  })

  it('stops calling the model once the budget runs out, and says so for the rest', async () => {
    h.generateReply
      .mockResolvedValueOnce(modelAnswer())
      .mockRejectedValueOnce(new AiError('budget', { code: 'budget_exceeded', status: 429 }))
    const { ctx } = setup({}, {})
    const r = await handleTranslate(ctx, 'base', { languages: ['ms', 'zh'] })
    expect(r.status).toBe(200)
    expect(r.body.results).toMatchObject([{ ok: true }, { language: 'zh', ok: false, code: 'budget_exceeded' }])

    h.generateReply.mockReset()
    h.generateReply.mockRejectedValue(new AiError('budget', { code: 'budget_exceeded', status: 429 }))
    const all = setup()
    const rAll = await handleTranslate(all.ctx, 'base', { languages: ['ms', 'zh'] })
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    // every language failed for the same reason: the typed 429
    expect(rAll.status).toBe(429)
    expect(rAll.body.code).toBe('budget_exceeded')
    expect(rAll.body.results.map((x) => x.code)).toEqual(['budget_exceeded', 'budget_exceeded'])
  })
})
