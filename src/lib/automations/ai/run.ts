import type {
  AiExtractField,
  AiExtractStepConfig,
  AiOnFailure,
  AiReplyStepConfig,
  AiSummarizeStepConfig,
  AiTranslateStepConfig,
  ConditionStepConfig,
} from '@/types'
import type { ChatMessage } from '@/lib/ai/types'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { buildConversationContext, getPreferredLanguage } from '@/lib/ai/context'
import { searchKnowledge } from '@/lib/ai/knowledge'
import { normalizeLanguage } from '@/lib/ai/knowledge-query'
import { extractCitations } from '@/lib/ai/citations'
import { latestUserMessage, recentCustomerText } from '@/lib/ai/query'
import { buildSummaryPrompt, cleanSummary } from '@/lib/ai/wrap-up'
import { formatTranscript } from '@/lib/ai/wrap-up-run'
import { groupHitsByArticle } from '@/lib/knowledge/excerpts'
import { languageName } from '@/lib/contacts/locale-options'
import { MAX_AI_STEPS_PER_RUN } from '../step-kinds'
import {
  checkExtractFields,
  clampMessages,
  clip,
  interpolatePlain,
  interpolateSafe,
  needsContactScope,
  parseYesNo,
  validContactFieldValue,
  validateExtraction,
  type InterpolationScope,
} from './parsers'
import { buildAskPrompt, buildExtractPrompt, buildTranslateTextPrompt } from './prompts'
import {
  AI_INPUT_MAX_CHARS,
  AI_JSON_MAX_TOKENS,
  AI_MESSAGE_CLIP_CHARS,
  AI_OUTPUT_MAX_CHARS,
  AI_REPLY_MAX_TOKENS,
  AI_STEPS_VAR,
  AiStepError,
  type AiStepResult,
  type AiStepRuntime,
} from './types'

// ============================================================
// Executing one AI step.
//
// `executeAiStep` is the single function the engine and the Test panel share.
// It PLANS: it reads the conversation, calls the model, validates the output
// and returns what the step decided plus the writes it would make (`effects`).
// It never writes. The engine applies the effects afterwards; the Test panel
// (`rt.dryRun`) never does. So a dry run cannot send, update or insert by
// construction, and the tests assert exactly that.
//
// It also never throws for an expected failure (AI off, budget used up,
// timeout, bad output ...): those come back as a result carrying `failure`,
// shaped by the step's On failure choice.
// ============================================================

export type PlannedStepType = 'ai_reply' | 'ai_extract' | 'ai_summarize' | 'ai_translate' | 'ai_question'

interface Acc {
  tokens: number
  /** Raw model output, kept only so a failed dry run can show what came back. */
  raw?: string
  /** Gates passed: the customer-facing fallback text may be sent. */
  gatesPassed?: boolean
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)

function blank(): AiStepResult {
  return { outcome: 'skipped', branch: null, text: '', varsPatch: {}, tokens: 0, effects: [], notes: [] }
}

export async function executeAiStep(
  type: PlannedStepType,
  config: Record<string, unknown>,
  rt: AiStepRuntime,
): Promise<AiStepResult> {
  const used = num(rt.vars[AI_STEPS_VAR])
  const acc: Acc = { tokens: 0 }
  try {
    if (used >= MAX_AI_STEPS_PER_RUN) {
      throw new AiStepError('step_limit', `AI step limit reached (${MAX_AI_STEPS_PER_RUN} per automation run)`)
    }
    let r: AiStepResult
    switch (type) {
      case 'ai_reply':
        r = await planReply(config as AiReplyStepConfig, rt, acc)
        break
      case 'ai_question':
        r = await planQuestion(config as unknown as ConditionStepConfig, rt, acc)
        break
      case 'ai_extract':
        r = await planExtract(config as unknown as AiExtractStepConfig, rt, acc)
        break
      case 'ai_summarize':
        r = await planSummarize(config as AiSummarizeStepConfig, rt, acc)
        break
      case 'ai_translate':
        r = await planTranslate(config as unknown as AiTranslateStepConfig, rt, acc)
        break
      default:
        throw new AiStepError('invalid_config', `unknown AI step: ${String(type)}`)
    }
    r.tokens = acc.tokens
    r.varsPatch = { [AI_STEPS_VAR]: used + 1, ...r.varsPatch }
    return r
  } catch (err) {
    const e = err instanceof AiStepError ? err : new AiStepError('ai_error', err instanceof Error ? err.message : 'The AI step failed.')
    // A step refused for the limit did not call the model: it does not count.
    const patch = e.code === 'step_limit' ? {} : { [AI_STEPS_VAR]: used + 1 }
    return failureResult(type, config, e, acc, patch, rt.dryRun)
  }
}

// ------------------------------------------------------------
// Failure policy
// ------------------------------------------------------------

function failureResult(
  type: PlannedStepType,
  config: Record<string, unknown>,
  err: AiStepError,
  acc: Acc,
  varsPatch: Record<string, unknown>,
  dryRun: boolean,
): AiStepResult {
  const r = blank()
  r.outcome = 'failed'
  r.tokens = acc.tokens
  r.varsPatch = varsPatch
  r.failure = { code: err.code, message: err.message }
  r.reason = err.code
  // A failed dry run shows what the model actually returned, to help fix a prompt.
  if (dryRun && acc.raw) r.text = clip(acc.raw, AI_OUTPUT_MAX_CHARS)

  const onFailure = config.on_failure as AiOnFailure | 'no' | undefined

  if (type === 'ai_question') {
    // Unsure and any failure are "No", unless the admin chose to stop.
    if (onFailure === 'stop') r.stop = true
    else r.branch = 'no'
    return r
  }
  if (type === 'ai_reply') {
    if (onFailure === 'stop') {
      r.stop = true
      return r
    }
    r.branch = 'no'
    const fallback = typeof config.fallback_text === 'string' ? config.fallback_text.trim() : ''
    if (onFailure === 'fallback' && fallback && config.mode !== 'draft' && acc.gatesPassed) {
      r.effects.push({ kind: 'send_reply', text: clip(fallback, AI_OUTPUT_MAX_CHARS), citedDocs: [], cited: [] })
      r.notes.push('sent the fallback text')
    }
    return r
  }
  // extract / summarise / translate: Stop (the default) or Skip and continue.
  if (onFailure === 'skip' || onFailure === 'fallback') r.outcome = 'skipped'
  else r.stop = true
  return r
}

// ------------------------------------------------------------
// Shared loading
// ------------------------------------------------------------

interface ConversationRow {
  id: string
  contact_id: string | null
  assigned_agent_id: string | null
  ai_autoreply_disabled: boolean | null
}

async function loadConversation(rt: AiStepRuntime): Promise<ConversationRow> {
  if (!rt.conversationId) throw new AiStepError('no_conversation', 'This step needs a conversation.')
  const { data } = await rt.db
    .from('conversations')
    .select('id, contact_id, assigned_agent_id, ai_autoreply_disabled')
    .eq('id', rt.conversationId)
    .eq('account_id', rt.accountId)
    .maybeSingle()
  if (!data) throw new AiStepError('no_conversation', 'Conversation not found.')
  return data as ConversationRow
}

/** Newest lines win: cut each message, then drop the oldest until it fits. */
export function clipMessages(messages: ChatMessage[]): ChatMessage[] {
  const cut = messages.map((m) => ({ ...m, content: clip(m.content, AI_MESSAGE_CLIP_CHARS) }))
  let total = cut.reduce((n, m) => n + m.content.length, 0)
  while (cut.length > 1 && total > AI_INPUT_MAX_CHARS) {
    total -= cut[0].content.length
    cut.shift()
  }
  return cut
}

async function transcriptOf(rt: AiStepRuntime, conversationId: string, n: number): Promise<string> {
  const history = await buildConversationContext(rt.db, conversationId, n)
  if (history.length === 0) throw new AiStepError('no_messages', 'There is nothing in this conversation to work from yet.')
  return formatTranscript(clipMessages(history))
}

async function scopeFor(rt: AiStepRuntime, ...templates: (string | undefined)[]): Promise<InterpolationScope> {
  const scope: InterpolationScope = {
    message: { text: rt.messageText },
    vars: rt.vars,
    closure: rt.closureNote ? { note: rt.closureNote } : undefined,
  }
  if (!needsContactScope(...templates)) return scope
  if (rt.conversationId) scope.conversation = { id: rt.conversationId }
  if (rt.contactId) {
    const { data } = await rt.db
      .from('contacts')
      .select('name, email, company, phone, language')
      .eq('id', rt.contactId)
      .eq('account_id', rt.accountId)
      .maybeSingle()
    const c = (data ?? {}) as Record<string, unknown>
    const name = typeof c.name === 'string' ? c.name : ''
    scope.contact = { ...c, first_name: name.split(/\s+/)[0] ?? '' }
  }
  return scope
}

function codeToName(code: string | undefined | null, fallback: string): string {
  if (!code || !code.trim()) return fallback
  try {
    return languageName(code.trim(), 'en') || fallback
  } catch {
    return fallback
  }
}

// ------------------------------------------------------------
// AI reply
// ------------------------------------------------------------

async function planReply(cfg: AiReplyStepConfig, rt: AiStepRuntime, acc: Acc): Promise<AiStepResult> {
  const mode = cfg.mode === 'draft' ? 'draft' : 'send'
  const r = blank()
  const couldnt = (reason: string): AiStepResult => ({ ...r, outcome: 'couldnt_answer', branch: 'no', reason })

  const conv = await loadConversation(rt)
  // The AI is paused on this thread ("AI take over"), or a person owns it.
  if (conv.ai_autoreply_disabled) return couldnt('ai_paused')
  if (mode === 'send' && conv.assigned_agent_id && !cfg.even_if_assigned) return couldnt('agent_assigned')
  acc.gatesPassed = true

  const config = await rt.ai.getConfig()
  const history = await buildConversationContext(rt.db, conv.id)
  if (history.length === 0) throw new AiStepError('no_messages', 'There is nothing in this conversation to answer yet.')
  // Only ever answer the customer's latest message. This is also what keeps a
  // replayed trigger from answering twice: once we (or an agent) have replied,
  // the last message is no longer the customer's.
  if (history[history.length - 1].role !== 'user') return couldnt('nothing_to_reply_to')

  const fixedLanguage = cfg.language && cfg.language !== 'match' ? cfg.language : null
  const language = fixedLanguage ?? (await getPreferredLanguage(rt.db, conv.id))
  const question = recentCustomerText(history)
  const hits = await searchKnowledge(rt.db, rt.accountId, config, question, {
    audience: 'ai',
    k: 5,
    language: normalizeLanguage(language),
  })
  const { excerpts, documents } = groupHitsByArticle(hits)
  if (hits.length > 0) r.effects.push({ kind: 'log_knowledge_use', hits })

  // Nothing to ground an answer in: no article matched and there is no
  // business context either. Do not spend tokens on a guess.
  if (hits.length === 0 && !config.systemPrompt?.trim()) {
    r.effects.push({ kind: 'log_gap', question: latestUserMessage(history) })
    return { ...couldnt('no_knowledge'), effects: r.effects }
  }

  const scope = await scopeFor(rt, cfg.instructions)
  const instructions = interpolateSafe(cfg.instructions ?? '', scope).trim()
  const businessContext = [config.systemPrompt?.trim(), instructions].filter(Boolean).join('\n\n')
  const system = buildSystemPrompt({
    userPrompt: businessContext || null,
    mode: 'auto_reply',
    knowledge: excerpts,
    preferredLanguage: language,
  })

  const out = await rt.ai.call({ system, messages: clipMessages(history), maxOutputTokens: AI_REPLY_MAX_TOKENS })
  acc.tokens += out.tokens
  acc.raw = out.text

  const { text: cleaned, cited } = extractCitations(out.text, excerpts.length)
  const text = clip(cleaned, AI_OUTPUT_MAX_CHARS).trim()
  if (out.handoff || !text) {
    if (hits.length === 0) r.effects.push({ kind: 'log_gap', question: latestUserMessage(history) })
    return { ...couldnt(out.handoff ? 'handoff' : 'empty'), effects: r.effects, tokens: acc.tokens }
  }

  const varKey = cleanVarKey(cfg.save_to, 'ai_reply')
  const citedDocs = cited.map((n) => documents[n - 1]).filter(Boolean)
  if (mode === 'send') {
    r.effects.push({ kind: 'send_reply', text, citedDocs: documents, cited })
  } else {
    r.effects.push({
      kind: 'internal_note',
      text: `AI draft reply (not sent): ${text}`,
      kbSources: (citedDocs.length > 0 ? citedDocs : documents.slice(0, 1)).slice(0, 5),
    })
  }
  return {
    ...r,
    outcome: 'answered',
    branch: 'yes',
    text,
    reason: mode === 'send' ? 'sent' : 'draft_note',
    varsPatch: { [varKey]: text },
  }
}

// ------------------------------------------------------------
// Ask AI (yes / no), the `ai_question` subject of a Condition
// ------------------------------------------------------------

async function planQuestion(cfg: ConditionStepConfig, rt: AiStepRuntime, acc: Acc): Promise<AiStepResult> {
  const r = blank()
  const scope = await scopeFor(rt, cfg.operand)
  const question = interpolateSafe(cfg.operand ?? '', scope).trim()
  if (!question) throw new AiStepError('invalid_config', 'Ask AI needs a question.')
  if (!rt.conversationId) throw new AiStepError('no_conversation', 'This step needs a conversation.')

  let transcript: string
  try {
    transcript = await transcriptOf(rt, rt.conversationId, clampMessages(cfg.ai_messages))
  } catch (err) {
    // An empty conversation has nothing to say yes to.
    if (err instanceof AiStepError && err.code === 'no_messages') {
      return { ...r, outcome: 'unsure', branch: 'no', text: 'unsure', reason: 'no_messages' }
    }
    throw err
  }

  const out = await rt.ai.call({
    system: buildAskPrompt({ question }),
    messages: [{ role: 'user', content: `Conversation:\n\n${transcript}` }],
    maxOutputTokens: 200,
  })
  acc.tokens += out.tokens
  acc.raw = out.text
  const { answer, reason } = parseYesNo(out.text)
  return {
    ...r,
    outcome: answer,
    // "unsure" is "No": documented in the builder next to the step.
    branch: answer === 'yes' ? 'yes' : 'no',
    text: answer,
    reason: reason ?? undefined,
  }
}

// ------------------------------------------------------------
// AI classify and extract
// ------------------------------------------------------------

async function planExtract(cfg: AiExtractStepConfig, rt: AiStepRuntime, acc: Acc): Promise<AiStepResult> {
  const fields = (cfg.fields ?? []) as AiExtractField[]
  const issues = checkExtractFields(fields)
  if (issues.length > 0) {
    throw new AiStepError('invalid_config', `Extract fields: ${issues[0].key ? `${issues[0].key}: ` : ''}${issues[0].message}`)
  }
  if (!rt.conversationId) throw new AiStepError('no_conversation', 'This step needs a conversation.')

  const scope = await scopeFor(rt, cfg.instructions)
  const transcript = await transcriptOf(rt, rt.conversationId, clampMessages(cfg.ai_messages))
  const out = await rt.ai.call({
    system: buildExtractPrompt({ fields, instructions: interpolateSafe(cfg.instructions ?? '', scope).trim() }),
    messages: [{ role: 'user', content: `Conversation:\n\n${transcript}` }],
    maxOutputTokens: AI_JSON_MAX_TOKENS,
  })
  acc.tokens += out.tokens
  acc.raw = out.text

  const ext = validateExtraction(fields, out.text)
  if (!ext) throw new AiStepError('bad_output', 'The model did not return JSON.')

  const r = blank()
  r.outcome = 'extracted'
  // vars.<key> for every field: the value, or empty when nothing (valid) was found.
  for (const f of fields) r.varsPatch[f.key] = f.key in ext.values ? ext.values[f.key] : ''
  r.json = { ...ext.values }
  r.text = JSON.stringify(ext.values)
  for (const bad of ext.invalid) r.notes.push(`${bad.key}: ${bad.message} (left empty)`)

  await planTargets(fields, ext.values, !!cfg.overwrite, rt, r)
  return r
}

async function planTargets(
  fields: AiExtractField[],
  values: Record<string, string | number | boolean>,
  overwrite: boolean,
  rt: AiStepRuntime,
  r: AiStepResult,
): Promise<void> {
  const targeted = fields.filter((f) => f.target && f.key in values)
  if (targeted.length === 0) return

  let tags: { id: string; name: string }[] | null = null
  const loadTags = async () => {
    if (tags) return tags
    const { data } = await rt.db
      .from('tags')
      .select('id, name')
      .eq('account_id', rt.accountId)
      .eq('approval_status', 'approved')
      .is('deleted_at', null)
    tags = (data ?? []) as { id: string; name: string }[]
    return tags
  }

  for (const f of targeted) {
    const value = values[f.key]
    const target = f.target!
    if (target.kind === 'contact_field') {
      if (!rt.contactId) continue
      const text = String(value)
      if (!validContactFieldValue(target.field, text)) {
        r.notes.push(`${f.key}: not a valid ${target.field} (not saved)`)
        continue
      }
      const { data } = await rt.db
        .from('contacts')
        .select(target.field)
        .eq('id', rt.contactId)
        .eq('account_id', rt.accountId)
        .maybeSingle()
      const existing = (data as Record<string, unknown> | null)?.[target.field]
      if (typeof existing === 'string' && existing.trim() && !overwrite) {
        r.notes.push(`${f.key}: ${target.field} already has a value, kept`)
        continue
      }
      r.effects.push({ kind: 'contact_field', field: target.field, value: text.trim() })
    } else if (target.kind === 'custom_field') {
      if (!rt.contactId) continue
      const { data: def } = await rt.db
        .from('custom_fields')
        .select('id')
        .eq('id', target.custom_field_id)
        .eq('account_id', rt.accountId)
        .maybeSingle()
      if (!def) {
        r.notes.push(`${f.key}: the custom field no longer exists`)
        continue
      }
      const { data: cur } = await rt.db
        .from('contact_custom_values')
        .select('value')
        .eq('contact_id', rt.contactId)
        .eq('custom_field_id', target.custom_field_id)
        .maybeSingle()
      const existing = (cur as { value?: unknown } | null)?.value
      if (existing !== undefined && existing !== null && String(existing).trim() && !overwrite) {
        r.notes.push(`${f.key}: the custom field already has a value, kept`)
        continue
      }
      const text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)
      r.effects.push({ kind: 'custom_field', customFieldId: target.custom_field_id, value: text })
    } else {
      // label / tag: only an existing one with the same name as the choice.
      const list = await loadTags()
      const hit = list.find((t) => t.name.trim().toLowerCase() === String(value).trim().toLowerCase())
      if (!hit) {
        r.notes.push(`${f.key}: there is no ${target.kind} named "${String(value)}" (nothing created)`)
        continue
      }
      if (target.kind === 'label' && !rt.conversationId) continue
      if (target.kind === 'tag' && !rt.contactId) continue
      r.effects.push({ kind: target.kind, tagId: hit.id, name: hit.name })
    }
  }
}

// ------------------------------------------------------------
// AI summarise
// ------------------------------------------------------------

const SUMMARY_MESSAGES = 40
const AI_MESSAGE_LOOKBACK = 10

async function planSummarize(cfg: AiSummarizeStepConfig, rt: AiStepRuntime, acc: Acc): Promise<AiStepResult> {
  if (!rt.conversationId) throw new AiStepError('no_conversation', 'This step needs a conversation.')
  const transcript = await transcriptOf(rt, rt.conversationId, SUMMARY_MESSAGES)
  const language = codeToName(cfg.language || process.env.NEXT_PUBLIC_APP_LOCALE, 'English')
  const out = await rt.ai.call({
    // The existing summary job's prompt and cleaner.
    system: buildSummaryPrompt({ language }),
    messages: [{ role: 'user', content: `Conversation:\n\n${transcript}` }],
    maxOutputTokens: 700,
  })
  acc.tokens += out.tokens
  acc.raw = out.text
  const summary = cleanSummary(out.text)
  if (!summary) throw new AiStepError('bad_output', 'The AI did not return a summary.')

  const r = blank()
  r.outcome = 'summarised'
  r.text = summary
  r.varsPatch[cleanVarKey(cfg.save_to, 'summary')] = summary
  if (cfg.post_note) r.effects.push({ kind: 'internal_note', text: `AI summary:\n${summary}` })
  return r
}

// ------------------------------------------------------------
// AI translate
// ------------------------------------------------------------

async function planTranslate(cfg: AiTranslateStepConfig, rt: AiStepRuntime, acc: Acc): Promise<AiStepResult> {
  if (!cfg.target_language?.trim()) throw new AiStepError('invalid_config', 'Choose a language to translate into.')
  const scope = await scopeFor(rt, cfg.source)

  let source = cfg.source?.trim() ? interpolatePlain(cfg.source, scope).trim() : (rt.messageText ?? '').trim()
  if (!source && !cfg.source?.trim() && rt.conversationId) {
    // No trigger message (a resumed wait, a closed conversation): the customer's last one.
    const history = await buildConversationContext(rt.db, rt.conversationId, AI_MESSAGE_LOOKBACK)
    source = latestUserMessage(history).trim()
  }
  if (!source) throw new AiStepError('no_messages', 'There is no text to translate.')

  const out = await rt.ai.call({
    system: buildTranslateTextPrompt({ language: codeToName(cfg.target_language, cfg.target_language) }),
    // The text is DATA in the user turn, never part of the instructions.
    messages: [{ role: 'user', content: clip(source, AI_INPUT_MAX_CHARS) }],
    maxOutputTokens: AI_REPLY_MAX_TOKENS,
  })
  acc.tokens += out.tokens
  acc.raw = out.text
  const text = clip(out.text.trim(), AI_OUTPUT_MAX_CHARS)
  if (!text) throw new AiStepError('bad_output', 'The AI did not return a translation.')

  const r = blank()
  r.outcome = 'translated'
  r.text = text
  r.varsPatch[cleanVarKey(cfg.save_to, 'translation')] = text
  return r
}

// ------------------------------------------------------------

/** A `save_to` value as a safe var key, or the default. */
export function cleanVarKey(raw: unknown, fallback: string): string {
  const k = typeof raw === 'string' ? raw.trim() : ''
  return /^[a-z][a-z0-9_]{0,31}$/.test(k) ? k : fallback
}

/** A short line for logs and the collapsed step: what a result means. */
export function describeResult(r: AiStepResult): string {
  if (r.failure) return `${r.outcome}: ${r.failure.message}`
  switch (r.outcome) {
    case 'answered':
      return r.reason === 'draft_note' ? 'answered (saved as a draft note)' : 'answered (sent)'
    case 'couldnt_answer':
      return `could not answer (${r.reason ?? 'unknown'})`
    case 'yes':
    case 'no':
    case 'unsure':
      return `${r.outcome}${r.reason ? `: ${r.reason}` : ''}`
    case 'extracted':
      return `extracted ${Object.keys(r.json ?? {}).length} field(s)${r.notes.length ? `; ${r.notes.join('; ')}` : ''}`
    case 'summarised':
      return 'summarised'
    case 'translated':
      return 'translated'
    default:
      return r.outcome
  }
}
