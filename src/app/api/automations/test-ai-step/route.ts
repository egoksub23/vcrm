import { NextResponse } from 'next/server'
import { assertCapability, requireCapability, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { createAiCaller } from '@/lib/automations/ai/caller'
import { dryRunStep, testKindFor } from '@/lib/automations/ai/dry-run'
import { AiStepError } from '@/lib/automations/ai/types'
import { clip } from '@/lib/automations/ai/parsers'

/**
 * POST /api/automations/test-ai-step
 *
 * The builder's "Test this step". Runs ONE AI step (AI reply, Ask AI, extract,
 * summarise, translate, or Create ticket with AI text) against a conversation
 * the admin picked, and returns what it would do.
 *
 *   - Needs BOTH `automations.manage` (you are building automations) and
 *     `ai.use` (you may spend AI tokens).
 *   - Dry run: it goes through the same `executeAiStep` the engine runs, in a
 *     mode that has no write path at all. Nothing is sent, saved, labelled or
 *     created.
 *   - It does spend real tokens. They are checked against the monthly budget
 *     and logged in the usage log (mode `automation`), like any AI call.
 *   - Rate limited per user and per account. The response never contains a
 *     system prompt.
 *
 * Body: { step: { step_type, step_config }, conversation_id, vars?, trigger_type? }
 * `vars` are sample values for `{{ vars.x }}` from earlier steps (keys starting
 * with `_` are ignored: those belong to the engine).
 */

const MAX_SAMPLE_VARS = 20
const MAX_SAMPLE_VALUE_CHARS = 500

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability('automations.manage')
    assertCapability(ctx, 'ai.use')
    const { supabase, accountId, userId } = ctx

    const userLimit = checkRateLimit(`automation-ai-test:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    const accountLimit = checkRateLimit(`ai-draft-acct:${accountId}`, RATE_LIMITS.aiDraftAccount)
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = (await request.json().catch(() => null)) as {
      step?: { step_type?: unknown; step_config?: unknown }
      conversation_id?: unknown
      vars?: unknown
      trigger_type?: unknown
    } | null

    const stepType = typeof body?.step?.step_type === 'string' ? body.step.step_type : ''
    const stepConfig =
      body?.step?.step_config && typeof body.step.step_config === 'object' && !Array.isArray(body.step.step_config)
        ? (body.step.step_config as Record<string, unknown>)
        : {}
    const step = { step_type: stepType, step_config: stepConfig }
    if (!testKindFor(step)) {
      return NextResponse.json({ error: 'This step cannot be tested.', code: 'not_testable' }, { status: 400 })
    }
    const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) {
      return NextResponse.json({ error: 'Pick a conversation to test with.', code: 'conversation_required' }, { status: 400 })
    }

    // The RLS-scoped client decides whether this user can see the conversation.
    const { data: conv } = await supabase
      .from('conversations')
      .select('id, contact_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conv) return NextResponse.json({ error: 'Conversation not found', code: 'not_found' }, { status: 404 })

    const admin = supabaseAdmin()
    // The trigger message: the customer's latest text message.
    const { data: last } = await admin
      .from('messages')
      .select('content_text')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .eq('is_internal', false)
      .eq('content_type', 'text')
      .order('created_at', { ascending: false })
      .limit(1)
    const messageText = ((last ?? [])[0] as { content_text?: string | null } | undefined)?.content_text ?? undefined

    // Sample variables from earlier steps, strings only, never the engine's own.
    const vars: Record<string, unknown> = {}
    if (body?.vars && typeof body.vars === 'object' && !Array.isArray(body.vars)) {
      for (const [k, v] of Object.entries(body.vars as Record<string, unknown>).slice(0, MAX_SAMPLE_VARS)) {
        if (k.startsWith('_') || !/^[a-z][a-z0-9_]{0,31}$/.test(k)) continue
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          vars[k] = typeof v === 'string' ? clip(v, MAX_SAMPLE_VALUE_CHARS) : v
        }
      }
    }
    const closureNote =
      body?.trigger_type === 'conversation_closed'
        ? await latestClosureNote(admin, conversationId)
        : undefined

    const result = await dryRunStep({
      db: admin,
      ai: createAiCaller({
        db: admin,
        accountId,
        conversationId,
        logUsage: true,
        // Its own bucket: testing must not eat the automations' shared one.
        rateKey: `automation-ai-test-calls:${accountId}`,
      }),
      accountId,
      conversationId,
      contactId: (conv as { contact_id?: string | null }).contact_id ?? null,
      messageText,
      vars,
      closureNote,
      step,
    })
    return NextResponse.json({ result })
  } catch (err) {
    if (err instanceof AiStepError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    }
    if (err instanceof Error && !(err as { status?: number }).status) {
      // A step that cannot run for a plain reason (create_ticket without a contact).
      console.error('[automations/test-ai-step] failed:', err)
      return NextResponse.json({ error: err.message, code: 'test_failed' }, { status: 400 })
    }
    return toErrorResponse(err)
  }
}

async function latestClosureNote(admin: ReturnType<typeof supabaseAdmin>, conversationId: string): Promise<string | undefined> {
  const { data } = await admin
    .from('conversation_events')
    .select('note')
    .eq('conversation_id', conversationId)
    .eq('event_type', 'closed')
    .order('created_at', { ascending: false })
    .limit(1)
  return ((data ?? [])[0] as { note?: string | null } | undefined)?.note ?? undefined
}
