import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateTicketStepConfig } from '@/types'
import { usesAi } from '../step-kinds'
import { planCreateTicket } from './create-ticket'
import { executeAiStep, describeResult, type PlannedStepType } from './run'
import type { AiCaller, AiEffect, AiOutcome, AiStepRuntime } from './types'
import { clip } from './parsers'

// ============================================================
// The Test panel's engine: run ONE step against ONE conversation and report
// what it would do, changing nothing.
//
// It goes through `executeAiStep` (and `planCreateTicket`), the same functions
// the engine runs, with `dryRun: true`. Neither of those writes; the writes
// live in `applyEffects` / `applyCreateTicket`, which this module never
// imports. So "no sending, no writes" holds by construction, and the tests
// also assert it against a database that fails on any write.
// ============================================================

export type TestStepKind = PlannedStepType | 'create_ticket'

/** What the step would do, as safe display data (never a prompt). */
export interface WouldDo {
  kind: 'send_reply' | 'internal_note' | 'contact_field' | 'custom_field' | 'label' | 'tag' | 'create_ticket'
  /** The text that would be sent or noted; the value that would be saved; the ticket subject. */
  text?: string
  /** contact_field: which field; label/tag: its name; create_ticket: the priority. */
  name?: string
}

export interface TestStepResponse {
  outcome: AiOutcome | 'created' | 'skipped'
  /** 'yes' / 'no' for AI reply (Answered / Couldn't answer) and Ask AI. */
  branch: 'yes' | 'no' | null
  /** The main output: reply text, summary, translation, the yes/no answer, or a ticket subject. */
  text: string
  /** Extract: the validated values. */
  json?: Record<string, unknown>
  /** Ask AI: the model's short reason. Others: why no answer was given. */
  reason?: string
  tokens: number
  notes: string[]
  wouldDo: WouldDo[]
  failure?: { code: string; message: string }
  /** create_ticket only. */
  ticket?: { subject: string; description: string; skip: 'open_ticket_exists' | null; usedAi: boolean }
  /** One line like the run log would have. */
  summary: string
}

export function testKindFor(step: { step_type: string; step_config?: Record<string, unknown> | null }): TestStepKind | null {
  if (!usesAi(step) && step.step_type !== 'create_ticket') return null
  if (step.step_type === 'condition') return 'ai_question'
  return step.step_type as TestStepKind
}

function wouldDo(effects: AiEffect[]): WouldDo[] {
  const out: WouldDo[] = []
  for (const e of effects) {
    switch (e.kind) {
      case 'send_reply':
        out.push({ kind: 'send_reply', text: e.text })
        break
      case 'internal_note':
        out.push({ kind: 'internal_note', text: e.text })
        break
      case 'contact_field':
        out.push({ kind: 'contact_field', name: e.field, text: e.value })
        break
      case 'custom_field':
        out.push({ kind: 'custom_field', text: e.value })
        break
      case 'label':
        out.push({ kind: 'label', name: e.name })
        break
      case 'tag':
        out.push({ kind: 'tag', name: e.name })
        break
      // log_gap / log_knowledge_use are bookkeeping, not something to show.
    }
  }
  return out
}

/** Run a step in dry-run mode. Never writes, never throws for a model failure. */
export async function dryRunStep(args: {
  db: SupabaseClient
  ai: AiCaller
  accountId: string
  conversationId: string
  contactId: string | null
  messageText?: string
  vars?: Record<string, unknown>
  closureNote?: string
  step: { step_type: string; step_config: Record<string, unknown> }
}): Promise<TestStepResponse> {
  const kind = testKindFor(args.step)
  if (!kind) throw new Error('This step cannot be tested.')

  const rt: AiStepRuntime = {
    db: args.db,
    ai: args.ai,
    accountId: args.accountId,
    automation: null,
    conversationId: args.conversationId,
    contactId: args.contactId,
    messageText: args.messageText,
    vars: { ...(args.vars ?? {}) },
    closureNote: args.closureNote,
    dryRun: true,
  }

  if (kind === 'create_ticket') {
    const cfg = args.step.step_config as unknown as CreateTicketStepConfig
    const plan = await planCreateTicket(cfg, rt)
    return {
      outcome: plan.skip ? 'skipped' : 'created',
      branch: null,
      text: plan.subject,
      reason: plan.skip ?? undefined,
      tokens: plan.tokens,
      notes: plan.notes,
      wouldDo: plan.skip ? [] : [{ kind: 'create_ticket', text: plan.subject, name: plan.priority }],
      failure: plan.aiFailure,
      ticket: { subject: plan.subject, description: plan.description, skip: plan.skip, usedAi: plan.usedAi },
      summary: plan.skip ? 'skipped: an open ticket already exists' : `would create a ticket${plan.usedAi ? ' (text written by AI)' : ''}`,
    }
  }

  const res = await executeAiStep(kind, args.step.step_config, rt)
  return {
    outcome: res.failure ? 'failed' : res.outcome,
    branch: res.branch,
    text: clip(res.text, 4096),
    json: res.json,
    reason: res.reason,
    tokens: res.tokens,
    notes: res.notes,
    wouldDo: wouldDo(res.effects),
    failure: res.failure,
    summary: describeResult(res),
  }
}
