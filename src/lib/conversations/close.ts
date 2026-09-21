import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Closing a conversation, and telling the `conversation_closed` automations.
//
// Every close goes through `close_conversation_with_note` (migration 065), the
// database function that requires a closing note and writes the session-log
// event. This module wraps that call so the trigger is dispatched from ONE
// server-side place, whoever closed the conversation:
//
//   - an agent, from the inbox (POST /api/conversations/close)
//   - an agent, in bulk (the same route, several ids)
//   - an automation's Close conversation step (engine.ts)
//
// It dispatches only when the conversation was open before, so closing an
// already-closed conversation (a double click, a repeated bulk close) never
// fires twice.
//
// Loop guard: an automation that closes conversations must not re-trigger
// itself. The dispatch carries `_chain`, the ids of the automations that led
// to this close; an automation already in the chain never runs again for it,
// and a chain stops growing after MAX_CLOSE_CHAIN links.
// ============================================================

export const MAX_CLOSE_CHAIN = 3
/** Key inside `context.vars` holding the automation ids already in the causal chain. */
export const CHAIN_VAR = '_chain'

export type ClosedBy =
  | { type: 'agent'; userId: string }
  | { type: 'automation'; automationId: string; automationName: string }

export interface CloseInput {
  /** Client whose session authorises the close: the agent's own (the database
   *  checks `conversations.manage`), or the service role for an automation. */
  rpcClient: SupabaseClient
  /** Service-role client for the reads and the dispatch. */
  admin: SupabaseClient
  accountId: string
  conversationId: string
  note: string
  closedBy: ClosedBy
  /** Known already (the engine has it); read from the conversation otherwise. */
  contactId?: string | null
  /** The automation chain that led here (`vars._chain` of the calling run). */
  chain?: string[]
  /** Run the dispatch later (the route passes `after`); default: await it. */
  defer?: (job: () => Promise<void>) => void
}

export interface CloseResult {
  /** The conversation is closed now. */
  closed: boolean
  /** It was already closed: the note was still recorded, nothing was dispatched. */
  wasClosed: boolean
  /** `conversation_closed` automations were (or will be, when deferred) dispatched. */
  dispatched: boolean
}

// A conversation closed twice within this window is dispatched once (two agents
// racing, a retried request). The status check above covers the ordinary case;
// this covers two calls that both read "open" before either wrote.
const RECENT_MS = 5_000
const recent = new Map<string, number>()

function claimDispatch(conversationId: string, now = Date.now()): boolean {
  for (const [k, t] of recent) if (now - t > RECENT_MS) recent.delete(k)
  if (recent.has(conversationId)) return false
  recent.set(conversationId, now)
  return true
}

/** Test hook: forget the recent-dispatch memory. */
export function resetCloseDispatchMemory(): void {
  recent.clear()
}

export async function closeConversation(input: CloseInput): Promise<CloseResult> {
  const { admin, accountId, conversationId } = input

  const { data: conv, error: convErr } = await admin
    .from('conversations')
    .select('id, status, contact_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (convErr) throw new Error(`conversation lookup failed: ${convErr.message}`)
  if (!conv) throw new Error('Conversation not found')
  const wasClosed = (conv as { status?: string }).status === 'closed'

  const { error } = await input.rpcClient.rpc('close_conversation_with_note', {
    p_conversation_id: conversationId,
    p_note: input.note,
  })
  if (error) throw error

  if (wasClosed || !claimDispatch(conversationId)) return { closed: true, wasClosed, dispatched: false }

  const chain = [...(input.chain ?? [])]
  if (input.closedBy.type === 'automation' && !chain.includes(input.closedBy.automationId)) {
    chain.push(input.closedBy.automationId)
  }
  if (chain.length > MAX_CLOSE_CHAIN) return { closed: true, wasClosed, dispatched: false }

  const contactId = input.contactId ?? (conv as { contact_id?: string | null }).contact_id ?? null
  const job = async () => {
    try {
      // Dynamic import: the engine imports this module for its Close step.
      const { runAutomationsForTrigger } = await import('@/lib/automations/engine')
      const closer = await closerName(admin, accountId, input.closedBy)
      await runAutomationsForTrigger({
        accountId,
        triggerType: 'conversation_closed',
        contactId,
        context: {
          conversation_id: conversationId,
          closure_note: input.note,
          vars: {
            closure_note: input.note,
            closed_by: closer,
            closed_by_type: input.closedBy.type,
            [CHAIN_VAR]: chain,
          },
        },
      })
    } catch (err) {
      console.error('[conversation close] conversation_closed dispatch failed:', err)
    }
  }

  if (input.defer) input.defer(job)
  else await job()
  return { closed: true, wasClosed, dispatched: true }
}

async function closerName(admin: SupabaseClient, accountId: string, by: ClosedBy): Promise<string> {
  if (by.type === 'automation') return by.automationName
  const { data } = await admin
    .from('profiles')
    .select('full_name')
    .eq('user_id', by.userId)
    .eq('account_id', accountId)
    .maybeSingle()
  return (data as { full_name?: string | null } | null)?.full_name?.trim() || 'An agent'
}

/** The automation ids already in the causal chain of a run's vars. */
export function chainOf(vars: Record<string, unknown> | undefined): string[] {
  const raw = vars?.[CHAIN_VAR]
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}
