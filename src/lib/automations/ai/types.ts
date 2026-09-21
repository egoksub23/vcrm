import type { AiConfig, AiUsage, ChatMessage } from '@/lib/ai/types'
import type { KnowledgeHit } from '@/lib/ai/knowledge'

// ============================================================
// Shared types and limits for the AI steps of an automation.
// See docs/automation-ai.md.
// ============================================================

// ---- Limits (guardrails) -------------------------------------------------

/** Default and allowed range of "how many latest messages the model reads". */
export const AI_MESSAGES_DEFAULT = 10
export const AI_MESSAGES_MIN = 1
export const AI_MESSAGES_MAX = 30

/** One customer message is cut to this many characters before it goes to the model. */
export const AI_MESSAGE_CLIP_CHARS = 2000
/** The whole transcript (or translation source) is cut to this many characters;
 *  the newest lines win. */
export const AI_INPUT_MAX_CHARS = 12_000
/** Text an AI step may put into a message or note: never longer than this. */
export const AI_OUTPUT_MAX_CHARS = 4096
/** A hard timeout per model call. */
export const AI_CALL_TIMEOUT_MS = 20_000
/** Output token caps per kind of job (a chat reply is short; JSON is shorter). */
export const AI_REPLY_MAX_TOKENS = 1024
export const AI_JSON_MAX_TOKENS = 600
/** What the logs and the Test panel keep of a model output. */
export const AI_LOG_OUTPUT_CHARS = 500

/** Extract: at most this many fields, and this many choices per choice field. */
export const AI_EXTRACT_MAX_FIELDS = 8
export const AI_EXTRACT_MAX_CHOICES = 12
export const AI_EXTRACT_TEXT_MAX_CHARS = 500
export const AI_EXTRACT_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/

/** Counter kept in `vars` so the per-run cap survives a `wait`. Hidden from pickers. */
export const AI_STEPS_VAR = '_ai_steps'

// ---- Errors --------------------------------------------------------------

export type AiStepErrorCode =
  | 'ai_not_configured'
  | 'notice_required'
  | 'budget_exceeded'
  | 'rate_limited'
  | 'timeout'
  | 'ai_error'
  | 'bad_output'
  | 'step_limit'
  | 'no_conversation'
  | 'no_messages'
  | 'invalid_config'

/** A reason an AI step could not run. Never carries a prompt. */
export class AiStepError extends Error {
  readonly code: AiStepErrorCode
  constructor(code: AiStepErrorCode, message: string) {
    super(message)
    this.name = 'AiStepError'
    this.code = code
  }
}

// ---- Caller (the seam tests replace with a fake) --------------------------

export interface AiCallRequest {
  system: string
  messages: ChatMessage[]
  maxOutputTokens?: number
}

export interface AiCallResult {
  text: string
  /** The model asked to hand off to a human (AI reply's auto-reply prompt). */
  handoff?: boolean
  usage: AiUsage | null
  /** total tokens the call used (0 when the provider did not say). */
  tokens: number
  model: string
  provider: string
}

export interface AiCaller {
  /** The connection the `automation` job resolves to. Throws AiStepError
   *  when AI is not set up, the job is off, or the privacy notice is unconfirmed. */
  getConfig(): Promise<AiConfig>
  /** One model call: rate limit, budget, timeout and usage log included. */
  call(req: AiCallRequest): Promise<AiCallResult>
}

// ---- Results -------------------------------------------------------------

export type AiOutcome =
  | 'answered'
  | 'couldnt_answer'
  | 'yes'
  | 'no'
  | 'unsure'
  | 'extracted'
  | 'summarised'
  | 'translated'
  | 'skipped'
  | 'failed'

/** A write a step would make. Built by the plan; only applied outside a dry run. */
export type AiEffect =
  | { kind: 'send_reply'; text: string; citedDocs: { id: string; title: string }[]; cited: number[] }
  | { kind: 'internal_note'; text: string; kbSources?: { id: string; title: string }[] }
  | { kind: 'log_gap'; question: string }
  | { kind: 'log_knowledge_use'; hits: KnowledgeHit[] }
  | { kind: 'contact_field'; field: 'name' | 'email' | 'company'; value: string }
  | { kind: 'custom_field'; customFieldId: string; value: string }
  | { kind: 'label'; tagId: string; name: string }
  | { kind: 'tag'; tagId: string; name: string }

export interface AiStepResult {
  outcome: AiOutcome
  /** For `ai_reply` and Ask AI: 'yes' = Answered / Yes, 'no' = Couldn't answer / No. */
  branch: 'yes' | 'no' | null
  /** Primary output text (reply, summary, translation, the yes/no answer). */
  text: string
  /** Structured output (extract: the validated values). */
  json?: Record<string, unknown>
  /** Short reason: the model's yes/no reason, or why an answer was not given. */
  reason?: string
  /** Merged into `context.vars` by the engine. */
  varsPatch: Record<string, unknown>
  tokens: number
  effects: AiEffect[]
  /** Human-readable notes (a field that failed validation, a value kept). Kept in logs. */
  notes: string[]
  /** Set when the model call failed (or was refused) and the step carried on. */
  failure?: { code: AiStepErrorCode; message: string }
  /** The On failure choice says Stop: the engine fails the step and the run. */
  stop?: boolean
}

/** What a step reads about the run it is in. */
export interface AiStepRuntime {
  /** Service-role client for READS; writes only ever go through the applier. */
  db: import('@supabase/supabase-js').SupabaseClient
  ai: AiCaller
  accountId: string
  automation: { id: string; name: string } | null
  conversationId: string | null
  contactId: string | null
  /** The message that fired the trigger, if any. */
  messageText?: string
  /** A copy of `context.vars`. */
  vars: Record<string, unknown>
  /** The closure note, when the trigger is `conversation_closed`. */
  closureNote?: string
  /** No writes: the plan is returned and nothing is applied. */
  dryRun: boolean
}
