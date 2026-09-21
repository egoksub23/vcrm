import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const rows = vi.hoisted(() => ({ inserted: [] as Record<string, unknown>[] }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: async (r: Record<string, unknown>[]) => {
        rows.inserted = r
        return { error: null }
      },
    }),
  }),
}))

import { AUTOMATION_TEMPLATES, getTemplate } from './templates'
import { insertSteps, type BuilderStepInput } from './steps-tree'
import { validateStepsForActivation, validateTriggerForActivation } from './validate'
import { hasBranches, MAX_AI_STEPS_PER_RUN, countAiSteps } from './step-kinds'
import { variablesFor, varsProducedBy } from './ai/vars'

describe('quick-start templates: AI', () => {
  it('keeps the ids stable', () => {
    expect(Object.keys(AUTOMATION_TEMPLATES)).toEqual([
      'welcome_message',
      'out_of_office',
      'lead_qualifier',
      'follow_up_reminder',
      'ai_first_response',
      'ai_classify_route',
      'ai_close_summary_ticket',
    ])
    expect(getTemplate('ai_first_response')?.slug).toBe('ai_first_response')
  })

  it('AI first response, then hand off: ai_reply, and on "Couldn\'t answer" an assignment and a label', () => {
    const t = AUTOMATION_TEMPLATES.ai_first_response
    expect(t.trigger_type).toBe('first_inbound_message')
    expect(t.steps.map((s) => s.step_type)).toEqual(['ai_reply', 'assign_to_team', 'add_conversation_label'])
    expect(t.steps[0].step_config).toMatchObject({ mode: 'send' })
    expect(t.steps.slice(1).every((s) => s.parent_index === 0 && s.branch === 'no')).toBe(true)
  })

  it('Classify and route: topic and sentiment, a label, a team', () => {
    const t = AUTOMATION_TEMPLATES.ai_classify_route
    expect(t.steps.map((s) => s.step_type)).toEqual(['ai_extract', 'add_conversation_label', 'assign_to_team'])
    const fields = (t.steps[0].step_config as { fields: { key: string; choices?: string[]; target?: { kind: string } | null }[] }).fields
    expect(fields.map((f) => f.key)).toEqual(['topic', 'sentiment'])
    expect(fields[0].target).toEqual({ kind: 'label' })
    expect(fields[1].choices).toEqual(['positive', 'neutral', 'negative'])
  })

  it('Close, summarise and open a ticket: conversation_closed, summary, an AI-written ticket, a label', () => {
    const t = AUTOMATION_TEMPLATES.ai_close_summary_ticket
    expect(t.trigger_type).toBe('conversation_closed')
    expect(t.steps.map((s) => s.step_type)).toEqual(['ai_summarize', 'create_ticket', 'add_conversation_label'])
    expect(t.steps[1].step_config).toMatchObject({ ai_write: true, skip_if_open: true })
    // The ticket reads the summary the step before produced.
    expect(String((t.steps[1].step_config as { description: string }).description)).toContain('{{ vars.summary }}')
  })

  it('each AI template is valid once its pickers (team, label) are filled, and within the 5-step cap', () => {
    for (const slug of ['ai_first_response', 'ai_classify_route', 'ai_close_summary_ticket'] as const) {
      const t = AUTOMATION_TEMPLATES[slug]
      const filled = t.steps.map((s) => ({
        step_type: s.step_type as string,
        step_config: { ...(s.step_config as Record<string, unknown>), ...(s.step_type === 'assign_to_team' ? { team_id: 'team-1' } : {}), ...(s.step_type === 'add_conversation_label' ? { tag_id: 'tag-1' } : {}) },
      }))
      expect(validateTriggerForActivation(t.trigger_type, t.trigger_config)).toEqual([])
      expect(validateStepsForActivation(filled, { aiSetup: { ok: true } }), slug).toEqual([])
      expect(countAiSteps(filled)).toBeLessThanOrEqual(MAX_AI_STEPS_PER_RUN)
    }
  })

  it('an unfilled template is refused at activation until the team and label are chosen (drafts save fine)', () => {
    const t = AUTOMATION_TEMPLATES.ai_first_response
    const issues = validateStepsForActivation(t.steps.map((s) => ({ step_type: s.step_type as string, step_config: s.step_config as Record<string, unknown> })))
    expect(issues.map((i) => i.message)).toEqual(expect.arrayContaining(['team is required', 'tag is required']))
  })

  it('every template step is a known step type', () => {
    for (const t of Object.values(AUTOMATION_TEMPLATES)) {
      for (const s of t.steps) {
        const issues = validateStepsForActivation([{ step_type: s.step_type as string, step_config: s.step_config as Record<string, unknown> }])
        expect(issues.some((i) => /unknown step type/.test(i.message)), `${t.slug}:${s.step_type}`).toBe(false)
      }
    }
  })

  it('the catalogue carries the seeds the templates ask for, in the ICU-safe raw form', () => {
    const en = JSON.parse(readFileSync(join(process.cwd(), 'messages', 'en.json'), 'utf8')).Automations.templates
    expect(en.ai_close_summary_ticket.seed.ticketSubject).toContain('{{ contact.name }}')
    expect(en.ai_first_response.seed.aiReplyInstructions).toBeTruthy()
  })
})

describe('saving steps: AI reply keeps its Answered / Couldn\'t answer children', () => {
  it('writes the children of an AI reply under it, with the yes / no branch', async () => {
    const tree: BuilderStepInput[] = [
      {
        id: 'r',
        step_type: 'ai_reply',
        step_config: { mode: 'send' },
        branches: {
          yes: [{ id: 'ok', step_type: 'add_tag', step_config: { tag_id: 't1' } }],
          no: [{ id: 'no', step_type: 'assign_to_team', step_config: { team_id: 'x' } }],
        },
      },
    ]
    expect(await insertSteps('auto-1', tree)).toBeNull()
    const byId = Object.fromEntries(rows.inserted.map((r) => [r.id as string, r]))
    expect(byId.r).toMatchObject({ parent_step_id: null, branch: null, step_type: 'ai_reply' })
    expect(byId.ok).toMatchObject({ parent_step_id: 'r', branch: 'yes' })
    expect(byId.no).toMatchObject({ parent_step_id: 'r', branch: 'no' })
  })

  it('still ignores branches on steps that do not branch, and keeps Condition working', async () => {
    await insertSteps('auto-1', [
      { id: 'a', step_type: 'send_message', step_config: {}, branches: { yes: [{ id: 'z', step_type: 'add_tag', step_config: {} }] } },
      { id: 'c', step_type: 'condition', step_config: { subject: 'ai_question' }, branches: { no: [{ id: 'n', step_type: 'add_tag', step_config: {} }] } },
    ])
    expect(rows.inserted.map((r) => r.id)).toEqual(['a', 'c', 'n'])
    expect(hasBranches('send_message')).toBe(false)
  })
})

describe('the Insert variable list', () => {
  const S = (cid: string, step_type: string, step_config: Record<string, unknown>, branches?: { yes: never[]; no: never[] }) => ({ cid, step_type, step_config, branches })

  it('lists the trigger and contact variables, plus what earlier AI steps produce', () => {
    const steps = [
      S('a', 'ai_extract', { fields: [{ key: 'sentiment' }, { key: 'topic' }, { key: 'Bad Key' }] }),
      S('b', 'ai_summarize', { save_to: 'recap' }),
      S('c', 'ai_translate', {}),
      S('d', 'ai_reply', {}, { yes: [], no: [] }),
      S('e', 'create_ticket', {}),
    ]
    const tokens = variablesFor(steps, 'e', { triggerType: 'new_message_received' }).map((v) => v.token)
    expect(tokens).toEqual(
      expect.arrayContaining([
        '{{ message.text }}',
        '{{ contact.name }}',
        '{{ vars.sentiment }}',
        '{{ vars.topic }}',
        '{{ vars.recap }}',
        '{{ vars.translation }}',
        '{{ vars.ai_reply }}',
      ]),
    )
    expect(tokens).not.toContain('{{ vars.Bad Key }}')
    expect(tokens).not.toContain('{{ closure.note }}')
  })

  it('only offers what comes BEFORE the step, and the closure note for conversation_closed', () => {
    const steps = [S('a', 'ai_summarize', {}), S('b', 'ai_translate', {})]
    expect(variablesFor(steps, 'a').map((v) => v.token)).not.toContain('{{ vars.summary }}')
    expect(variablesFor(steps, 'b').map((v) => v.token)).toContain('{{ vars.summary }}')
    expect(variablesFor(steps, 'b').map((v) => v.token)).not.toContain('{{ vars.translation }}')
    expect(variablesFor(steps, 'b', { triggerType: 'conversation_closed' }).map((v) => v.token)).toContain('{{ closure.note }}')
  })

  it('reads the variables of steps inside branches', () => {
    const inner = S('in', 'ai_summarize', {})
    const steps = [{ cid: 'r', step_type: 'ai_reply', step_config: {}, branches: { yes: [inner], no: [] } }, S('after', 'create_ticket', {})]
    expect(variablesFor(steps as never, 'after').map((v) => v.token)).toContain('{{ vars.summary }}')
  })

  it('varsProducedBy: defaults and a rejected name', () => {
    expect(varsProducedBy({ step_type: 'ai_summarize', step_config: {} })).toEqual(['summary'])
    expect(varsProducedBy({ step_type: 'ai_summarize', step_config: { save_to: 'x y' } })).toEqual(['summary'])
    expect(varsProducedBy({ step_type: 'send_message', step_config: {} })).toEqual([])
  })
})
