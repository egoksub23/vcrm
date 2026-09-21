import type { CreateTicketStepConfig, TicketCategory, TicketPriority } from '@/types'
import { buildConversationContext } from '@/lib/ai/context'
import { buildTicketDraftPrompt, parseTicketDraft } from '@/lib/ai/wrap-up'
import { formatTranscript } from '@/lib/ai/wrap-up-run'
import { languageName } from '@/lib/contacts/locale-options'
import { ACTIVE_STATUSES } from '@/lib/tickets/constants'
import { ticketKey } from '@/lib/tickets/key'
import { MAX_AI_STEPS_PER_RUN } from '../step-kinds'
import { clip, interpolatePlain, type InterpolationScope } from './parsers'
import { clipMessages } from './run'
import { AI_JSON_MAX_TOKENS, AI_STEPS_VAR, AiStepError, type AiStepRuntime } from './types'

// ============================================================
// The Create ticket step. Same creation path as the ticket dialog: the
// per-account number comes from `next_ticket_number`, the row goes into
// `tickets` (so the watchers, SLA, activity and audit triggers all run), and
// the ticket's `created_by` is null because no person made it. An internal
// comment says which automation did.
//
// Split like the AI steps: `planCreateTicket` reads (and may call the AI) and
// decides; `applyCreateTicket` writes. A dry run stops after the plan.
// ============================================================

const CATEGORIES: TicketCategory[] = ['general', 'billing', 'technical', 'feature_request', 'bug', 'account', 'other']
const PRIORITIES: TicketPriority[] = ['urgent', 'high', 'normal', 'low']
const SUBJECT_MAX = 200
const DESCRIPTION_MAX = 5000
const FALLBACK_SUBJECT = 'Follow-up from conversation'

export interface TicketPlan {
  /** Why nothing will be created. */
  skip: 'open_ticket_exists' | null
  existing?: { id: string; number: number }
  subject: string
  description: string
  category: TicketCategory
  priority: TicketPriority
  assignedAgentId: string | null
  assignedTeamId: string | null
  contactId: string | null
  conversationId: string | null
  /** The subject and description came from the AI. */
  usedAi: boolean
  /** The AI was asked and failed: the templated text is used. */
  aiFailure?: { code: string; message: string }
  tokens: number
  varsPatch: Record<string, unknown>
  notes: string[]
}

export async function planCreateTicket(cfg: CreateTicketStepConfig, rt: AiStepRuntime): Promise<TicketPlan> {
  const notes: string[] = []
  const conversationId = rt.conversationId

  // The contact: the run's, else the conversation's.
  let contactId = rt.contactId
  if (!contactId && conversationId) {
    const { data } = await rt.db
      .from('conversations')
      .select('contact_id')
      .eq('id', conversationId)
      .eq('account_id', rt.accountId)
      .maybeSingle()
    contactId = (data as { contact_id?: string | null } | null)?.contact_id ?? null
  }
  if (!contactId) throw new Error('create_ticket needs a contact')

  const plan: TicketPlan = {
    skip: null,
    subject: '',
    description: '',
    category: CATEGORIES.includes(cfg.category as TicketCategory) ? (cfg.category as TicketCategory) : 'general',
    priority: PRIORITIES.includes(cfg.priority as TicketPriority) ? (cfg.priority as TicketPriority) : 'normal',
    assignedAgentId: null,
    assignedTeamId: null,
    contactId,
    conversationId,
    usedAi: false,
    tokens: 0,
    varsPatch: {},
    notes,
  }

  // Skip if one is already open for this conversation (default on).
  if (cfg.skip_if_open !== false && conversationId) {
    const { data } = await rt.db
      .from('tickets')
      .select('id, ticket_number')
      .eq('account_id', rt.accountId)
      .eq('conversation_id', conversationId)
      .in('status', ACTIVE_STATUSES)
      .limit(1)
    const hit = ((data ?? []) as { id: string; ticket_number: number }[])[0]
    if (hit) {
      plan.skip = 'open_ticket_exists'
      plan.existing = { id: hit.id, number: hit.ticket_number }
      return plan
    }
  }

  // Assignee and team: must belong to this account (the service role skips RLS).
  if (cfg.assigned_team_id) {
    const { data } = await rt.db
      .from('teams')
      .select('id')
      .eq('id', cfg.assigned_team_id)
      .eq('account_id', rt.accountId)
      .maybeSingle()
    if (data) plan.assignedTeamId = cfg.assigned_team_id
    else notes.push('the team no longer exists, left unassigned')
  }
  if (cfg.assigned_agent_id) {
    const { data } = await rt.db
      .from('profiles')
      .select('user_id')
      .eq('user_id', cfg.assigned_agent_id)
      .eq('account_id', rt.accountId)
      .maybeSingle()
    if (data) plan.assignedAgentId = cfg.assigned_agent_id
    else notes.push('the agent is no longer on the team, left unassigned')
  }

  // Templated text first: it is also the fallback when the AI fails.
  const scope: InterpolationScope = {
    message: { text: rt.messageText },
    vars: rt.vars,
    closure: rt.closureNote ? { note: rt.closureNote } : undefined,
    conversation: conversationId ? { id: conversationId } : undefined,
  }
  if (/\{\{\s*contact\./.test(`${cfg.subject} ${cfg.description ?? ''}`)) {
    const { data } = await rt.db
      .from('contacts')
      .select('name, email, company, phone')
      .eq('id', contactId)
      .eq('account_id', rt.accountId)
      .maybeSingle()
    const c = (data ?? {}) as Record<string, unknown>
    scope.contact = { ...c, first_name: typeof c.name === 'string' ? c.name.split(/\s+/)[0] : '' }
  }
  plan.subject = clip(interpolatePlain(cfg.subject ?? '', scope).trim() || FALLBACK_SUBJECT, SUBJECT_MAX)
  plan.description = clip(interpolatePlain(cfg.description ?? '', scope).trim(), DESCRIPTION_MAX)

  if (cfg.ai_write && conversationId) {
    const used = typeof rt.vars[AI_STEPS_VAR] === 'number' ? (rt.vars[AI_STEPS_VAR] as number) : 0
    try {
      if (used >= MAX_AI_STEPS_PER_RUN) {
        throw new AiStepError('step_limit', `AI step limit reached (${MAX_AI_STEPS_PER_RUN} per automation run)`)
      }
      const history = await buildConversationContext(rt.db, conversationId, 40)
      if (history.length === 0) throw new AiStepError('no_messages', 'There is nothing in this conversation to work from yet.')
      plan.varsPatch[AI_STEPS_VAR] = used + 1
      const out = await rt.ai.call({
        // The closing-note pipeline's prompt style: same untrusted-conversation rule.
        system: buildTicketDraftPrompt({ language: languageName(process.env.NEXT_PUBLIC_APP_LOCALE || 'en', 'en') || 'English' }),
        messages: [{ role: 'user', content: `Conversation:\n\n${formatTranscript(clipMessages(history))}` }],
        maxOutputTokens: AI_JSON_MAX_TOKENS,
      })
      plan.tokens += out.tokens
      const draft = parseTicketDraft(out.text)
      if (!draft) throw new AiStepError('bad_output', 'The AI did not return a usable ticket.')
      plan.subject = clip(draft.subject, SUBJECT_MAX)
      plan.description = clip(draft.description, DESCRIPTION_MAX)
      plan.usedAi = true
    } catch (err) {
      const e = err instanceof AiStepError ? err : new AiStepError('ai_error', 'The AI request failed.')
      plan.aiFailure = { code: e.code, message: e.message }
      notes.push(`AI text failed (${e.message}); used the template text`)
    }
  }
  return plan
}

export interface CreatedTicket {
  id: string
  number: number
  key: string
}

/** Write the ticket. Service-role `rt.db`. Throws when it cannot be created. */
export async function applyCreateTicket(
  plan: TicketPlan,
  rt: AiStepRuntime,
  automationName: string,
): Promise<CreatedTicket> {
  const db = rt.db

  const insertOnce = async () => {
    // The same per-account counter as next_ticket_number (the ticket dialog's),
    // in the server-only twin: there is no user session here to hold tickets.work.
    const { data: num, error: numErr } = await db.rpc('next_ticket_number_system', { p_account_id: rt.accountId })
    if (numErr || num == null) throw new Error(`ticket number failed: ${numErr?.message ?? 'no number'}`)
    const { data, error } = await db
      .from('tickets')
      .insert({
        account_id: rt.accountId,
        ticket_number: num,
        contact_id: plan.contactId,
        conversation_id: plan.conversationId,
        subject: plan.subject,
        description: plan.description || null,
        category: plan.category,
        priority: plan.priority,
        assigned_agent_id: plan.assignedAgentId,
        assigned_team_id: plan.assignedTeamId,
        // No person created it: the system did.
        created_by: null,
      })
      .select('id, ticket_number')
      .single()
    return { data: data as { id: string; ticket_number: number } | null, error }
  }

  let { data, error } = await insertOnce()
  // A number taken between the counter and the insert: take the next one once.
  if (error && (error as { code?: string }).code === '23505') ({ data, error } = await insertOnce())
  if (error || !data) throw new Error(`ticket insert failed: ${error?.message ?? 'no row'}`)

  // The activity note. Best-effort: the ticket exists either way.
  const { error: noteErr } = await db.from('ticket_comments').insert({
    ticket_id: data.id,
    account_id: rt.accountId,
    author_id: null,
    body: `Created by automation "${automationName}"`,
    mentions: [],
  })
  if (noteErr) console.error('[automations] ticket note failed:', noteErr)

  const { data: acct } = await db.from('accounts').select('ticket_key_prefix').eq('id', rt.accountId).maybeSingle()
  const prefix = (acct as { ticket_key_prefix?: string | null } | null)?.ticket_key_prefix
  return { id: data.id, number: data.ticket_number, key: ticketKey(prefix, data.ticket_number) }
}
