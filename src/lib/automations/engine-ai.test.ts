import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Engine dispatch for the AI steps, Create ticket and the
// conversation_closed trigger, against a fake AI client and an in-memory
// stand-in for the service-role client.
// ------------------------------------------------------------

type Row = Record<string, unknown>
type Filter = ['eq' | 'neq' | 'is' | 'gte' | 'in', string, unknown]

const h = vi.hoisted(() => ({
  s: {
    automations: [] as Row[],
    steps: [] as Row[],
    conversation: { id: 'conv-1', account_id: 'acct-1', contact_id: 'c1', status: 'open', assigned_agent_id: null, ai_autoreply_disabled: false, last_channel_type: 'whatsapp' } as Row,
    contacts: [{ id: 'c1', account_id: 'acct-1', name: 'Casey Lee', email: '', company: '' }] as Row[],
    tags: [] as Row[],
    tickets: [] as Row[],
    inserts: [] as { table: string; payload: Row }[],
    updates: [] as { table: string; payload: Row }[],
    rpcs: [] as { name: string; args: Row }[],
    logSteps: [] as Row[],
    logStatus: '' as string,
    logErrors: [] as unknown[],
    ticketSeq: 41,
    history: [{ role: 'user', content: 'Hi, I want a refund' }] as { role: string; content: string }[],
  },
  ai: null as unknown,
  sent: [] as Row[],
  notes: [] as Row[],
}))

vi.mock('./admin-client', () => {
  const s = h.s
  function filterRows(rows: Row[], filters: Filter[]) {
    return rows.filter((r) =>
      filters.every(([op, col, val]) => {
        const v = r[col] ?? null
        if (op === 'eq') return v === val
        if (op === 'neq') return v !== val
        if (op === 'is') return v === val
        if (op === 'gte') return typeof v === 'number' && v >= (val as number)
        if (op === 'in') return (val as unknown[]).includes(v)
        return true
      }),
    )
  }

  function resolve(ops: { table: string; type: string; payload?: Row; filters: Filter[] }) {
    const { table, type, payload, filters } = ops
    if (type === 'insert') {
      s.inserts.push({ table, payload: payload as Row })
      if (table === 'automation_logs') return { data: { id: 'log1' }, error: null }
      if (table === 'tickets') return { data: { id: 'tk-1', ticket_number: (payload as Row).ticket_number }, error: null }
      return { data: null, error: null }
    }
    if (type === 'update' || type === 'upsert') {
      s.updates.push({ table, payload: payload as Row })
      if (table === 'automation_logs') {
        const p = payload as Row
        if (Array.isArray(p.steps_executed)) s.logSteps = p.steps_executed as Row[]
        if (typeof p.status === 'string') s.logStatus = p.status
        if (p.error_message) s.logErrors.push(p.error_message)
      }
      return { data: null, error: null }
    }
    switch (table) {
      case 'contacts':
        return { data: filterRows(s.contacts, filters)[0] ?? null, error: null }
      case 'conversations':
        return { data: s.conversation, error: null }
      case 'automations':
        return { data: filterRows(s.automations, filters), error: null }
      case 'automation_steps':
        return { data: filterRows(s.steps, filters).sort((a, b) => (a.position as number) - (b.position as number)), error: null }
      case 'automation_logs':
        return { data: { steps_executed: s.logSteps, status: s.logStatus }, error: null }
      case 'tags':
        return { data: filterRows(s.tags, filters), error: null }
      case 'tickets':
        return { data: filterRows(s.tickets, filters), error: null }
      case 'accounts':
        return { data: { ticket_key_prefix: 'VIR', default_currency: 'USD' }, error: null }
      case 'profiles':
        return { data: { user_id: 'agent-1', full_name: 'Alex Agent' }, error: null }
      case 'teams':
        return { data: { id: 'team-1' }, error: null }
      default:
        return { data: null, error: null }
    }
  }

  function builder(table: string) {
    const ops = { table, type: 'select', payload: undefined as Row | undefined, filters: [] as Filter[] }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Row) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: Row) => ((ops.type = 'update'), (ops.payload = p), b),
      delete: () => ((ops.type = 'delete'), b),
      upsert: (p: Row) => ((ops.type = 'upsert'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      neq: (k: string, v: unknown) => (ops.filters.push(['neq', k, v]), b),
      is: (k: string, v: unknown) => (ops.filters.push(['is', k, v]), b),
      gte: (k: string, v: unknown) => (ops.filters.push(['gte', k, v]), b),
      in: (k: string, v: unknown) => (ops.filters.push(['in', k, v]), b),
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(resolve(ops)).then(ok, bad),
    }
    return b
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: (name: string, args: Row) => {
        s.rpcs.push({ name, args })
        if (name === 'next_ticket_number_system') return Promise.resolve({ data: ++s.ticketSeq, error: null })
        if (name === 'close_conversation_with_note') s.conversation = { ...s.conversation, status: 'closed' }
        return Promise.resolve({ data: null, error: null })
      },
    }),
  }
})

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async (a: Row) => {
    h.sent.push({ via: 'send_message', text: a.text })
    return { whatsapp_message_id: 'm1' }
  }),
  engineSendTemplate: vi.fn(),
  engineSendInteractive: vi.fn(),
}))
vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: vi.fn(async (_db: unknown, _acct: string, p: Row) => {
    h.sent.push({ via: 'ai_reply', text: p.contentText, senderType: p.senderType, aiGenerated: p.aiGenerated })
    return { whatsappMessageId: 'w1' }
  }),
}))
vi.mock('@/lib/ai/auto-reply', () => ({ sendSourcesAfterReply: vi.fn(async () => {}) }))
vi.mock('@/lib/conversations/comment-write', () => ({
  postInternalComment: vi.fn(async (_db: unknown, p: Row) => {
    h.notes.push(p)
    return {}
  }),
}))
vi.mock('./ai/caller', () => ({ createAiCaller: () => h.ai }))
vi.mock('@/lib/ai/context', () => ({
  buildConversationContext: vi.fn(async () => h.s.history),
  getPreferredLanguage: vi.fn(async () => null),
}))
vi.mock('@/lib/ai/knowledge', () => ({
  searchKnowledge: vi.fn(async () => [
    { chunkId: 'c', documentId: 'doc-1', title: 'Refunds', category: null, language: 'en', content: 'Refunds\n\nWithin 5 days.', score: 1, via: 'keyword' },
  ]),
  logKnowledgeGap: vi.fn(),
  logKnowledgeUse: vi.fn(),
}))
vi.mock('@/lib/conversations/label-write', () => ({
  addConversationLabelIfAbsent: vi.fn(async () => true),
  removeConversationLabel: vi.fn(),
}))
vi.mock('@/lib/contacts/tag-write', () => ({ addContactTagIfAbsent: vi.fn(async () => true) }))
vi.mock('@/lib/conversations/auto-label', () => ({ applyAutoLabels: vi.fn() }))

import { runAutomationsForTrigger } from './engine'
import { resetCloseDispatchMemory } from '@/lib/conversations/close'
import { AiStepError } from './ai/types'
import { fakeAi, type FakeReply } from './ai/test-helpers'

const A = 'acct-1'

function automation(id: string, trigger: string, name = id): Row {
  return { id, account_id: A, user_id: 'u1', name, trigger_type: trigger, trigger_config: {}, is_active: true }
}
function step(id: string, autoId: string, type: string, config: Row, position = 0, parent: string | null = null, branch: string | null = null): Row {
  return { id, automation_id: autoId, step_type: type, step_config: config, position, parent_step_id: parent, branch }
}
const send = (id: string, autoId: string, text: string, position = 0, parent: string | null = null, branch: string | null = null) =>
  step(id, autoId, 'send_message', { text }, position, parent, branch)

function use(replies: FakeReply[], opts?: Parameters<typeof fakeAi>[1]) {
  const ai = fakeAi(replies, opts)
  h.ai = ai
  return ai
}

async function run(trigger = 'new_message_received', context: Row = {}) {
  await runAutomationsForTrigger({
    accountId: A,
    triggerType: trigger as never,
    contactId: 'c1',
    context: { conversation_id: 'conv-1', message_text: 'Hi, I want a refund', ...context },
  })
}

const sentTexts = () => h.sent.map((m) => m.text)
// The i-th AI (or Create ticket) entry of the log. A branch's steps are logged
// before their parent's own entry, so an index into the raw list would not do.
const AI_KINDS = ['condition', 'ai_reply', 'ai_extract', 'ai_summarize', 'ai_translate', 'create_ticket']
const logStep = (i = 0) =>
  h.s.logSteps.filter((l) => AI_KINDS.includes(l.step_type as string))[i] as Row & {
    detail?: string
    outcome?: string
    tokens?: number
    output?: string
    status?: string
  }

beforeEach(() => {
  Object.assign(h.s, {
    automations: [],
    steps: [],
    conversation: { id: 'conv-1', account_id: A, contact_id: 'c1', status: 'open', assigned_agent_id: null, ai_autoreply_disabled: false, last_channel_type: 'whatsapp' },
    contacts: [{ id: 'c1', account_id: A, name: 'Casey Lee', email: '', company: '' }],
    tags: [],
    tickets: [],
    inserts: [],
    updates: [],
    rpcs: [],
    logSteps: [],
    logStatus: '',
    logErrors: [],
    ticketSeq: 41,
    history: [{ role: 'user', content: 'Hi, I want a refund' }],
  })
  h.sent = []
  h.notes = []
  resetCloseDispatchMemory()
})

// ------------------------------------------------------------
describe('Ask AI as a Condition subject', () => {
  const setup = (config: Row = {}) => {
    h.s.automations = [automation('a1', 'new_message_received')]
    h.s.steps = [
      step('q', 'a1', 'condition', { subject: 'ai_question', operand: 'Is the customer asking for a refund?', ...config }),
      send('y', 'a1', 'YES-PATH', 0, 'q', 'yes'),
      send('n', 'a1', 'NO-PATH', 0, 'q', 'no'),
    ]
  }

  it('yes takes the Yes branch and logs the outcome, tokens and the model reason', async () => {
    setup()
    use(['{"answer":"yes","reason":"asks for money back"}'])
    await run()
    expect(sentTexts()).toEqual(['YES-PATH'])
    expect(logStep(0)).toMatchObject({ step_type: 'condition', status: 'success', outcome: 'yes', tokens: 30, output: 'yes' })
    expect(logStep(0).detail).toContain('branch=yes')
    expect(logStep(0).detail).toContain('asks for money back')
    expect(h.s.logStatus).toBe('success')
  })

  it.each([
    ['no', 'no'],
    ['unsure', 'unsure'],
    ['I cannot tell, really', 'unsure'],
    ['', 'unsure'],
  ])('%j takes the No branch (outcome %s)', async (reply, outcome) => {
    setup()
    use([reply || ' '])
    await run()
    expect(sentTexts()).toEqual(['NO-PATH'])
    expect(logStep(0).outcome).toBe(outcome)
  })

  it.each([
    ['budget used up', new AiStepError('budget_exceeded', 'AI budget used up')],
    ['timeout', new AiStepError('timeout', 'The AI provider took too long to respond.')],
  ])('a failure (%s) takes the No branch by default and is logged', async (_n, err) => {
    setup()
    use([err])
    await run()
    expect(sentTexts()).toEqual(['NO-PATH'])
    expect(logStep(0)).toMatchObject({ status: 'skipped', outcome: 'failed' })
    expect(logStep(0).detail).toContain(err.message)
  })

  it('AI not set up takes the No branch, and "stop" fails the run without running a branch', async () => {
    setup()
    use([], { configError: new AiStepError('ai_not_configured', 'AI is not set up') })
    await run()
    expect(sentTexts()).toEqual(['NO-PATH'])

    h.sent = []
    h.s.logSteps = []
    setup({ on_failure: 'stop' })
    use([], { configError: new AiStepError('ai_not_configured', 'AI is not set up') })
    await run()
    expect(sentTexts()).toEqual([])
    expect(h.s.logStatus).toBe('failed')
    expect(logStep(0).status).toBe('failed')
  })
})

// ------------------------------------------------------------
describe('AI reply', () => {
  const setup = (config: Row = {}) => {
    h.s.automations = [automation('a1', 'new_message_received')]
    h.s.steps = [
      step('r', 'a1', 'ai_reply', { mode: 'send', ...config }),
      send('ok', 'a1', 'ANSWERED-PATH', 0, 'r', 'yes'),
      send('no', 'a1', 'COULDNT-PATH', 0, 'r', 'no'),
    ]
  }

  it('sends the answer as the bot, flagged AI-generated, then continues in "Answered"', async () => {
    setup()
    use(['Refunds arrive within 5 days [1].'])
    await run()
    expect(h.sent).toEqual([
      { via: 'ai_reply', text: 'Refunds arrive within 5 days.', senderType: 'bot', aiGenerated: true },
      { via: 'send_message', text: 'ANSWERED-PATH' },
    ])
    expect(logStep(0)).toMatchObject({ step_type: 'ai_reply', outcome: 'answered', status: 'success', tokens: 30 })
    expect(logStep(0).output).toBe('Refunds arrive within 5 days.')
  })

  it('a hand-off signal sends nothing and continues in "Couldn\'t answer"', async () => {
    setup()
    use([{ text: '', handoff: true }])
    await run()
    expect(sentTexts()).toEqual(['COULDNT-PATH'])
    expect(logStep(0).outcome).toBe('couldnt_answer')
    expect(logStep(0).detail).toContain('handoff')
  })

  it('an agent assigned means no send and no AI call, unless "even if assigned"', async () => {
    setup()
    h.s.conversation = { ...h.s.conversation, assigned_agent_id: 'agent-1' }
    const ai = use([])
    await run()
    expect(sentTexts()).toEqual(['COULDNT-PATH'])
    expect(ai.calls).toHaveLength(0)
  })

  it('AI paused on the conversation ("AI take over") is respected', async () => {
    setup()
    h.s.conversation = { ...h.s.conversation, ai_autoreply_disabled: true }
    const ai = use([])
    await run()
    expect(sentTexts()).toEqual(['COULDNT-PATH'])
    expect(ai.calls).toHaveLength(0)
  })

  it('the AI\'s own reply never triggers new_message_received again: nothing is dispatched', async () => {
    setup()
    use(['Refunds arrive within 5 days [1].'])
    await run()
    // One run, one log row: the outbound bot message did not fire the trigger.
    expect(h.s.inserts.filter((i) => i.table === 'automation_logs')).toHaveLength(1)
  })

  it('on failure: fallback text is sent, the flow continues in "Couldn\'t answer"', async () => {
    setup({ on_failure: 'fallback', fallback_text: 'A person will reply soon.' })
    use([new AiStepError('budget_exceeded', 'AI budget used up')])
    await run()
    expect(sentTexts()).toEqual(['A person will reply soon.', 'COULDNT-PATH'])
    expect(logStep(0)).toMatchObject({ status: 'skipped', outcome: 'failed' })
    expect(logStep(0).detail).toContain('AI budget used up')
  })

  it('on failure: stop fails the run and nothing else runs', async () => {
    setup({ on_failure: 'stop' })
    use([new AiStepError('timeout', 'The AI provider took too long to respond.')])
    await run()
    expect(sentTexts()).toEqual([])
    expect(h.s.logStatus).toBe('failed')
    expect(h.s.logErrors[0]).toContain('took too long')
  })

  it('draft mode leaves an internal note and sends nothing to the customer', async () => {
    setup({ mode: 'draft' })
    use(['Refunds arrive within 5 days [1].'])
    await run()
    expect(h.sent.filter((m) => m.via === 'ai_reply')).toEqual([])
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0]).toMatchObject({ senderType: 'bot', userId: null })
    expect(String(h.notes[0].text)).toContain('AI draft reply (not sent)')
  })
})

// ------------------------------------------------------------
describe('AI classify and extract', () => {
  const fields = [
    { key: 'sentiment', description: 'Mood', type: 'choice', choices: ['positive', 'negative'], target: { kind: 'label' } },
    { key: 'email', description: 'Email', type: 'text', target: { kind: 'contact_field', field: 'email' } },
  ]

  it('feeds vars to later steps, saves the contact field and applies the existing label', async () => {
    h.s.automations = [automation('a1', 'new_message_received')]
    h.s.steps = [
      step('x', 'a1', 'ai_extract', { fields }, 0),
      send('s', 'a1', 'Mood: {{ vars.sentiment }} / {{ vars.email }}', 1),
    ]
    h.s.tags = [{ id: 'tag-neg', name: 'Negative', account_id: A, approval_status: 'approved', deleted_at: null }]
    use(['{"sentiment":"negative","email":"casey@example.com"}'])
    await run('new_message_received', { vars: { _tag_chain_depth: 3 } })

    expect(sentTexts()).toEqual(['Mood: negative / casey@example.com'])
    expect(h.s.updates.find((u) => u.table === 'contacts')?.payload).toMatchObject({ email: 'casey@example.com' })
    expect(logStep(0)).toMatchObject({ outcome: 'extracted', status: 'success' })
    expect(logStep(0).detail).toContain('label')
  })

  it('malformed JSON stops the run by default, and can be skipped', async () => {
    h.s.automations = [automation('a1', 'new_message_received')]
    h.s.steps = [step('x', 'a1', 'ai_extract', { fields }, 0), send('s', 'a1', 'AFTER', 1)]
    use(['The mood is negative.'])
    await run()
    expect(sentTexts()).toEqual([])
    expect(h.s.logStatus).toBe('failed')
    expect(logStep(0).detail).toContain('did not return JSON')

    h.s.logSteps = []
    h.s.steps = [step('x', 'a1', 'ai_extract', { fields, on_failure: 'skip' }, 0), send('s', 'a1', 'AFTER', 1)]
    use(['The mood is negative.'])
    await run()
    expect(sentTexts()).toEqual(['AFTER'])
    expect(logStep(0).status).toBe('skipped')
    expect(h.s.updates.filter((u) => u.table === 'contacts')).toEqual([])
  })

  it('does not overwrite an existing contact value, and writes an invalid one nowhere', async () => {
    h.s.contacts = [{ id: 'c1', account_id: A, name: 'Casey', email: 'old@example.com', company: '' }]
    h.s.automations = [automation('a1', 'new_message_received')]
    h.s.steps = [step('x', 'a1', 'ai_extract', { fields: [fields[1]] }, 0)]
    use(['{"email":"new@example.com"}'])
    await run()
    expect(h.s.updates.filter((u) => u.table === 'contacts')).toEqual([])
    expect(logStep(0).detail).toContain('already has a value')
  })
})

// ------------------------------------------------------------
describe('AI summarise and AI translate', () => {
  it('summarise puts the summary in vars and an internal note; translate reads it back', async () => {
    h.s.automations = [automation('a1', 'new_message_received')]
    h.s.steps = [
      step('s', 'a1', 'ai_summarize', { post_note: true }, 0),
      step('t', 'a1', 'ai_translate', { source: '{{ vars.summary }}', target_language: 'ko' }, 1),
      send('m', 'a1', 'KO: {{ vars.translation }}', 2),
    ]
    use(['- Customer wants a refund', '- 고객이 환불을 원합니다'])
    await run()
    expect(sentTexts()).toEqual(['KO: - 고객이 환불을 원합니다'])
    expect(String(h.notes[0].text)).toContain('AI summary:')
    expect(h.s.logSteps.map((l) => l.outcome)).toEqual(['summarised', 'translated', undefined])
  })
})

// ------------------------------------------------------------
describe('the cap of 5 AI steps per run', () => {
  it('the sixth AI step is refused (logged as skipped when the step says skip) and the model is called 5 times', async () => {
    h.s.automations = [automation('a1', 'new_message_received')]
    h.s.steps = Array.from({ length: 6 }, (_, i) => step(`s${i}`, 'a1', 'ai_summarize', { on_failure: 'skip', save_to: `sum${i}` }, i))
    const ai = use(Array.from({ length: 5 }, () => '- ok'))
    await run()
    expect(ai.calls).toHaveLength(5)
    expect(h.s.logSteps.map((l) => l.status)).toEqual(['success', 'success', 'success', 'success', 'success', 'skipped'])
    expect(String(h.s.logSteps[5].detail)).toContain('limit')
  })

  it('by default the sixth stops the run', async () => {
    h.s.automations = [automation('a1', 'new_message_received')]
    h.s.steps = Array.from({ length: 6 }, (_, i) => step(`s${i}`, 'a1', 'ai_summarize', {}, i))
    use(Array.from({ length: 5 }, () => '- ok'))
    await run()
    expect(h.s.logStatus).toBe('failed')
  })
})

// ------------------------------------------------------------
describe('logs never carry a prompt', () => {
  it('holds the step name, outcome, tokens and a 500-character output, and nothing from the system prompt', async () => {
    h.s.automations = [automation('a1', 'new_message_received')]
    h.s.steps = [step('s', 'a1', 'ai_summarize', {}, 0)]
    use(['x'.repeat(900)])
    await run()
    const entry = logStep(0)
    expect(entry.output).toHaveLength(500)
    expect(entry.tokens).toBe(30)
    const everything = JSON.stringify([h.s.logSteps, h.s.updates.filter((u) => u.table === 'automation_logs')])
    expect(everything).not.toContain('untrusted')
    expect(everything).not.toContain('summarise a customer conversation')
  })
})

// ------------------------------------------------------------
describe('Create ticket', () => {
  const cfg = { category: 'billing', priority: 'high', subject: 'Follow-up: {{ contact.name }}', description: 'Wants: {{ vars.summary }}', skip_if_open: true }

  beforeEach(() => {
    h.s.automations = [automation('a1', 'new_message_received', 'Ticket bot')]
  })

  it('creates the ticket through the same path: next number, no creator, linked to the conversation, plus a note', async () => {
    h.s.steps = [step('t', 'a1', 'create_ticket', cfg, 0), send('m', 'a1', 'Opened {{ vars.ticket_key }}', 1)]
    use([])
    await run('new_message_received', { vars: { summary: 'a refund' } })

    expect(h.s.rpcs.map((r) => r.name)).toContain('next_ticket_number_system')
    const ticket = h.s.inserts.find((i) => i.table === 'tickets')!.payload
    expect(ticket).toMatchObject({
      account_id: A,
      ticket_number: 42,
      contact_id: 'c1',
      conversation_id: 'conv-1',
      subject: 'Follow-up: Casey Lee',
      description: 'Wants: a refund',
      category: 'billing',
      priority: 'high',
      created_by: null,
    })
    expect(h.s.inserts.find((i) => i.table === 'ticket_comments')!.payload).toMatchObject({
      ticket_id: 'tk-1',
      author_id: null,
      body: 'Created by automation "Ticket bot"',
    })
    // The ticket key respects the account's prefix, and later steps can use it.
    expect(sentTexts()).toEqual(['Opened VIR-42'])
    expect(logStep(0).detail).toContain('ticket VIR-42 created')
  })

  it('skips when an open ticket already exists for the conversation', async () => {
    h.s.tickets = [{ id: 'old', account_id: A, conversation_id: 'conv-1', ticket_number: 7, status: 'open' }]
    h.s.steps = [step('t', 'a1', 'create_ticket', cfg, 0), send('m', 'a1', 'AFTER', 1)]
    use([])
    await run()
    expect(h.s.inserts.filter((i) => i.table === 'tickets')).toEqual([])
    expect(h.s.rpcs.map((r) => r.name)).not.toContain('next_ticket_number_system')
    expect(logStep(0)).toMatchObject({ status: 'skipped' })
    expect(logStep(0).detail).toContain('open ticket already exists')
    expect(sentTexts()).toEqual(['AFTER'])
  })

  it('a resolved ticket does not count as open, and "skip if open" can be turned off', async () => {
    h.s.tickets = [{ id: 'old', account_id: A, conversation_id: 'conv-1', ticket_number: 7, status: 'resolved' }]
    h.s.steps = [step('t', 'a1', 'create_ticket', cfg, 0)]
    use([])
    await run()
    expect(h.s.inserts.filter((i) => i.table === 'tickets')).toHaveLength(1)

    h.s.inserts = []
    h.s.tickets = [{ id: 'old', account_id: A, conversation_id: 'conv-1', ticket_number: 7, status: 'open' }]
    h.s.steps = [step('t', 'a1', 'create_ticket', { ...cfg, skip_if_open: false }, 0)]
    await run()
    expect(h.s.inserts.filter((i) => i.table === 'tickets')).toHaveLength(1)
  })

  it('lets the AI write the subject and description', async () => {
    h.s.steps = [step('t', 'a1', 'create_ticket', { ...cfg, ai_write: true }, 0)]
    use(['{"subject":"Refund for order A-77","description":"The customer wants a refund for A-77."}'])
    await run()
    expect(h.s.inserts.find((i) => i.table === 'tickets')!.payload).toMatchObject({
      subject: 'Refund for order A-77',
      description: 'The customer wants a refund for A-77.',
    })
    expect(logStep(0)).toMatchObject({ outcome: 'created_with_ai', tokens: 30 })
  })

  it('falls back to the templated text when the AI fails or answers badly', async () => {
    h.s.steps = [step('t', 'a1', 'create_ticket', { ...cfg, ai_write: true }, 0)]
    use([new AiStepError('budget_exceeded', 'AI budget used up')])
    await run('new_message_received', { vars: { summary: 'a refund' } })
    expect(h.s.inserts.find((i) => i.table === 'tickets')!.payload).toMatchObject({ subject: 'Follow-up: Casey Lee', description: 'Wants: a refund' })
    expect(logStep(0).detail).toContain('AI text failed (AI budget used up); used the template text')

    h.s.inserts = []
    use(['not json at all'])
    await run()
    expect(h.s.inserts.find((i) => i.table === 'tickets')!.payload).toMatchObject({ subject: 'Follow-up: Casey Lee' })
  })

  it('counts an AI-written ticket toward the 5 AI steps', async () => {
    h.s.steps = [step('t', 'a1', 'create_ticket', { ...cfg, ai_write: true }, 0)]
    const ai = use([])
    await run('new_message_received', { vars: { _ai_steps: 5 } })
    expect(ai.calls).toHaveLength(0)
    expect(h.s.inserts.find((i) => i.table === 'tickets')!.payload).toMatchObject({ subject: 'Follow-up: Casey Lee' })
  })
})

// ------------------------------------------------------------
describe('conversation_closed', () => {
  it('a Close conversation step dispatches it once, with the note and the closer in context', async () => {
    h.s.automations = [automation('closer', 'new_message_received', 'Auto closer'), automation('watch', 'conversation_closed', 'On close')]
    h.s.steps = [
      step('c1', 'closer', 'close_conversation', {}, 0),
      send('w1', 'watch', 'Closed: {{ closure.note }} / {{ vars.closed_by }}', 0),
    ]
    use([])
    await run()
    expect(h.s.rpcs.filter((r) => r.name === 'close_conversation_with_note')).toHaveLength(1)
    expect(sentTexts()).toEqual(['Closed: Closed automatically by automation "Auto closer" / Auto closer'])
    // Two runs: the closer, and the conversation_closed automation, once.
    expect(h.s.inserts.filter((i) => i.table === 'automation_logs')).toHaveLength(2)
  })

  it('the automation that closed it never re-fires for that close (loop guard)', async () => {
    // Both listen for conversation_closed AND one of them closes: the closer must not run itself again.
    h.s.automations = [automation('loop', 'conversation_closed', 'Closes on close')]
    h.s.steps = [step('c1', 'loop', 'close_conversation', {}, 0), send('m', 'loop', 'RAN', 1)]
    use([])
    // Fired as if `loop` itself had closed the conversation.
    await run('conversation_closed', { vars: { _chain: ['loop'] } })
    expect(sentTexts()).toEqual([])
    expect(h.s.inserts.filter((i) => i.table === 'automation_logs')).toHaveLength(0)
  })

  it('closing an already-closed conversation does not dispatch again', async () => {
    h.s.conversation = { ...h.s.conversation, status: 'closed' }
    h.s.automations = [automation('closer', 'new_message_received', 'Auto closer'), automation('watch', 'conversation_closed', 'On close')]
    h.s.steps = [step('c1', 'closer', 'close_conversation', {}, 0), send('w1', 'watch', 'SHOULD-NOT-RUN', 0)]
    use([])
    await run()
    expect(sentTexts()).toEqual([])
    expect(h.s.inserts.filter((i) => i.table === 'automation_logs')).toHaveLength(1)
  })
})
