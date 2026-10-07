import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// Engine dispatch for the Doc Sign trigger and the Send document for signing step,
// against an in-memory stand-in for the service-role client. The Doc Sign services
// themselves are not run here (send-sign-document.test.ts covers the step's own logic).
// ------------------------------------------------------------

type Row = Record<string, unknown>
type Filter = ['eq' | 'is' | 'gte', string, unknown]

const h = vi.hoisted(() => ({
  s: {
    automations: [] as Row[],
    steps: [] as Row[],
    contacts: [{ id: 'c1', account_id: 'acct-1', name: 'Casey Lee', email: 'casey@example.com', phone: '+60123456789', company: 'Kedai Casey' }] as Row[],
    logSteps: [] as Row[],
    logStatus: '',
    sent: [] as string[],
    tagsAdded: [] as string[],
  },
  runner: vi.fn(),
}))

vi.mock('./admin-client', () => {
  const s = h.s
  const rowsFor = (rows: Row[], filters: Filter[]) =>
    rows.filter((r) =>
      filters.every(([op, col, val]) => {
        const v = r[col] ?? null
        if (op === 'eq') return v === val
        if (op === 'is') return v === val
        if (op === 'gte') return typeof v === 'number' && v >= (val as number)
        return true
      }),
    )
  function resolve(ops: { table: string; type: string; payload?: Row; filters: Filter[] }) {
    const { table, type, payload, filters } = ops
    if (type === 'insert') return table === 'automation_logs' ? { data: { id: 'log1' }, error: null } : { data: null, error: null }
    if (type === 'update') {
      if (table === 'automation_logs') {
        const p = payload as Row
        if (Array.isArray(p.steps_executed)) s.logSteps = p.steps_executed as Row[]
        if (typeof p.status === 'string') s.logStatus = p.status
      }
      return { data: null, error: null }
    }
    switch (table) {
      case 'contacts':
        return { data: rowsFor(s.contacts, filters)[0] ?? null, error: null }
      case 'automations':
        return { data: rowsFor(s.automations, filters), error: null }
      case 'automation_steps':
        return { data: rowsFor(s.steps, filters).sort((a, b) => (a.position as number) - (b.position as number)), error: null }
      case 'automation_logs':
        return { data: { steps_executed: s.logSteps, status: s.logStatus }, error: null }
      case 'conversations':
        return { data: { id: 'conv-1' }, error: null }
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
      delete: () => b,
      upsert: () => b,
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      is: (k: string, v: unknown) => (ops.filters.push(['is', k, v]), b),
      gte: (k: string, v: unknown) => (ops.filters.push(['gte', k, v]), b),
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(resolve(ops)).then(ok, bad),
    }
    return b
  }
  return { supabaseAdmin: () => ({ from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) }) }
})

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async (a: Row) => {
    h.s.sent.push(String(a.text))
    return { whatsapp_message_id: 'm1' }
  }),
  engineSendTemplate: vi.fn(),
  engineSendInteractive: vi.fn(),
}))
vi.mock('./send-sign-document', () => ({ runSendSignDocument: (...a: unknown[]) => h.runner(...a), docKey: (c: string | null, t: string) => `${c ?? ''}:${t}` }))
vi.mock('@/lib/platform/active', () => ({ isAccountActive: async () => true }))
vi.mock('@/lib/contacts/tag-write', () => ({
  addContactTagIfAbsent: vi.fn(async (_db: unknown, a: Row) => {
    h.s.tagsAdded.push(String(a.tagId))
    return true
  }),
}))

import { runAutomationsForTrigger, triggerMatches } from './engine'
import type { SignEventContext } from './sign-event'
import type { Automation } from '@/types'

const ACCOUNT = 'acct-1'

const sign = (over: Partial<SignEventContext> = {}): SignEventContext => ({
  document_id: 'doc-1',
  reference: 'SIGN-2026-0007',
  title: 'Merchant Application',
  status: 'completed',
  event: 'completed',
  template: 'Merchant Application',
  template_id: 'tpl-1',
  category_id: '',
  final_sha256: 'f'.repeat(64),
  verify_url: 'https://halo.example/verify/doc-1',
  ...over,
})

function automation(over: Row = {}): Row {
  return { id: 'a1', account_id: ACCOUNT, user_id: 'owner-1', name: 'Merchant signed', trigger_type: 'sign_document_event', trigger_config: {}, is_active: true, ...over }
}
function step(position: number, step_type: string, step_config: Row): Row {
  return { id: `s${position}`, automation_id: 'a1', parent_step_id: null, branch: null, position, step_type, step_config }
}

beforeEach(() => {
  h.s.automations = []
  h.s.steps = []
  h.s.logSteps = []
  h.s.logStatus = ''
  h.s.sent = []
  h.s.tagsAdded = []
  h.runner.mockReset()
})

describe('triggerMatches: sign_document_event', () => {
  const a = (cfg: Row) => ({ trigger_type: 'sign_document_event', trigger_config: cfg }) as unknown as Automation
  it('uses the events and filters of the configuration', () => {
    expect(triggerMatches(a({}), { sign: sign() })).toBe(true)
    expect(triggerMatches(a({}), { sign: sign({ event: 'viewed' }) })).toBe(false)
    expect(triggerMatches(a({ events: ['viewed'] }), { sign: sign({ event: 'viewed' }) })).toBe(true)
    expect(triggerMatches(a({ template_id: 'other' }), { sign: sign() })).toBe(false)
    expect(triggerMatches(a({}), {})).toBe(false)
  })
})

describe('dispatching a Secure Sign event', () => {
  it('runs the automations whose trigger matches, with the sign context and the contact', async () => {
    h.s.automations = [automation({ trigger_config: { events: ['completed'], template_id: 'tpl-1' } }), automation({ id: 'a2', trigger_config: { events: ['declined'] } })]
    h.s.steps = [step(0, 'send_message', { text: 'Thanks {{ contact.name }}, {{ sign.reference }} ({{ sign.event }}) {{ sign.template }}' })]
    await runAutomationsForTrigger({ accountId: ACCOUNT, triggerType: 'sign_document_event', contactId: 'c1', context: { sign: sign() } })
    // only a1 ran (a2 listens to declined): one message
    expect(h.s.sent).toEqual(['Thanks Casey Lee, SIGN-2026-0007 (completed) Merchant Application'])
    expect(h.s.logStatus).toBe('success')
  })

  it('a document with no contact still runs steps that need none', async () => {
    h.s.automations = [automation()]
    h.s.steps = [step(0, 'send_message', { text: 'x' })]
    await runAutomationsForTrigger({ accountId: ACCOUNT, triggerType: 'sign_document_event', contactId: null, context: { sign: sign() } })
    // send_message needs a contact: the run fails cleanly, it does not throw
    expect(h.s.logStatus).toBe('failed')
    expect(h.s.sent).toEqual([])
  })

  it('does not resolve {{ contact.* }} when the text does not mention it (no contact read for plain text)', async () => {
    h.s.automations = [automation()]
    h.s.steps = [step(0, 'send_message', { text: 'Hello there' })]
    await runAutomationsForTrigger({ accountId: ACCOUNT, triggerType: 'sign_document_event', contactId: 'c1', context: { sign: sign() } })
    expect(h.s.sent).toEqual(['Hello there'])
  })
})

describe('the Send document for signing step', () => {
  function setup(stepConfig: Row, extra: Row[] = []) {
    h.s.automations = [automation({ trigger_type: 'tag_added', trigger_config: { tag_id: 't1' } })]
    h.s.steps = [step(0, 'send_sign_document', stepConfig), ...extra]
  }
  const cfg: Row = {
    template_id: 'tpl-1',
    title: 'Application for {{ contact.name }}',
    recipients: [{ role_key: 'merchant', source: 'contact', channel: 'email' }],
    merge_values: { company: '{{ contact.company }}' },
    send: true,
  }
  const run = () => runAutomationsForTrigger({ accountId: ACCOUNT, triggerType: 'tag_added', contactId: 'c1', context: { tag_id: 't1' } })

  it('hands the runner the contact, the owner, the interpolation and the loop depth, and passes its variables on', async () => {
    h.runner.mockResolvedValue({ step: { status: 'success', outcome: 'sent', detail: 'document SIGN-1 sent to 1 person' }, varsPatch: { sign_document_id: 'doc-9', sign_reference: 'SIGN-1' } })
    setup(cfg, [step(1, 'send_message', { text: 'Sent {{ vars.sign_reference }} / {{ vars.sign_document_id }}' })])
    await run()
    expect(h.runner).toHaveBeenCalledTimes(1)
    const input = h.runner.mock.calls[0][0]
    expect(input).toMatchObject({ accountId: ACCOUNT, ownerUserId: 'owner-1', contactId: 'c1', automation: { id: 'a1', name: 'Merchant signed' } })
    expect(input.contact).toMatchObject({ name: 'Casey Lee', email: 'casey@example.com', phone: '+60123456789', company: 'Kedai Casey', first_name: 'Casey' })
    expect(input.text('Application for {{ contact.name }} / {{ contact.company }}')).toBe('Application for Casey Lee / Kedai Casey')
    // the next step sees what the step wrote
    expect(h.s.sent).toEqual(['Sent SIGN-1 / doc-9'])
    expect(h.s.logStatus).toBe('success')
    expect(h.s.logSteps[0]).toMatchObject({ step_type: 'send_sign_document', status: 'success', outcome: 'sent' })
  })

  it('carries the depth of the Secure Sign chain it is part of', async () => {
    h.runner.mockResolvedValue({ step: { status: 'success', outcome: 'sent', detail: 'ok' }, varsPatch: {} })
    h.s.automations = [automation()]
    h.s.steps = [step(0, 'send_sign_document', cfg)]
    await runAutomationsForTrigger({ accountId: ACCOUNT, triggerType: 'sign_document_event', contactId: 'c1', context: { sign: sign(), vars: { _sign_chain_depth: 2 } } })
    expect(h.runner.mock.calls[0][0].vars).toMatchObject({ _sign_chain_depth: 2 })
  })

  it('a skipped step (Secure Sign said no) is logged as skipped and the run goes on', async () => {
    h.runner.mockResolvedValue({ step: { status: 'skipped', outcome: 'sign_limit_reached', detail: 'skipped: limit' }, varsPatch: {} })
    setup(cfg, [step(1, 'send_message', { text: 'still here' })])
    await run()
    expect(h.s.logSteps.map((r) => r.status)).toEqual(['skipped', 'success'])
    expect(h.s.sent).toEqual(['still here'])
    expect(h.s.logStatus).toBe('success')
  })

  it('an unexpected failure fails the run like any other step', async () => {
    h.runner.mockRejectedValue(new Error('database is down'))
    setup(cfg, [step(1, 'send_message', { text: 'never' })])
    await run()
    expect(h.s.logStatus).toBe('failed')
    expect(h.s.logSteps[0]).toMatchObject({ status: 'failed', detail: 'database is down' })
    expect(h.s.sent).toEqual([])
  })
})
