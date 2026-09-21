import { describe, expect, it } from 'vitest'
import { validateStepsForActivation, validateTriggerForActivation, stepsUseAi } from './validate'
import { countAiSteps, flattenSteps, hasBranches, isAiStepType, usesAi, MAX_AI_STEPS_PER_RUN } from './step-kinds'

type S = { step_type: string; step_config: Record<string, unknown>; branches?: { yes?: S[]; no?: S[] } }

const ask = (over: Record<string, unknown> = {}): S => ({
  step_type: 'condition',
  step_config: { subject: 'ai_question', operand: 'Is the customer angry?', ...over },
})
const reply = (over: Record<string, unknown> = {}): S => ({ step_type: 'ai_reply', step_config: { mode: 'send', ...over } })
const summarize = (): S => ({ step_type: 'ai_summarize', step_config: {} })
const messages = (issues: { message: string }[]) => issues.map((i) => i.message)

describe('step kinds', () => {
  it('knows the AI steps, which steps branch, and which use AI', () => {
    for (const t of ['ai_reply', 'ai_extract', 'ai_summarize', 'ai_translate']) expect(isAiStepType(t)).toBe(true)
    expect(isAiStepType('create_ticket')).toBe(false)
    expect(hasBranches('condition')).toBe(true)
    expect(hasBranches('ai_reply')).toBe(true)
    expect(hasBranches('send_message')).toBe(false)
    expect(usesAi(ask())).toBe(true)
    expect(usesAi({ step_type: 'condition', step_config: { subject: 'tag_presence' } })).toBe(false)
    // Create ticket calls the AI only when asked to.
    expect(usesAi({ step_type: 'create_ticket', step_config: { subject: 'x' } })).toBe(false)
    expect(usesAi({ step_type: 'create_ticket', step_config: { subject: 'x', ai_write: true } })).toBe(true)
  })

  it('walks the branches of an AI reply and of a condition', () => {
    const tree: S[] = [
      { ...reply(), branches: { yes: [summarize()], no: [{ ...ask(), branches: { yes: [summarize()], no: [] } }] } },
    ]
    expect(flattenSteps(tree)).toHaveLength(4)
    expect(countAiSteps(tree)).toBe(4)
  })
})

describe('validation: AI steps', () => {
  it('a well-formed AI automation activates', () => {
    const steps: S[] = [
      reply({ on_failure: 'fallback', fallback_text: 'A person will reply.' }),
      ask({ ai_messages: 10 }),
      { step_type: 'ai_extract', step_config: { fields: [{ key: 'topic', type: 'choice', choices: ['a', 'b'], description: 'x' }], on_failure: 'skip' } },
      { step_type: 'ai_translate', step_config: { target_language: 'ko' } },
      { step_type: 'create_ticket', step_config: { subject: 'Follow-up', ai_write: true } },
    ]
    expect(validateStepsForActivation(steps, { aiSetup: { ok: true } })).toEqual([])
  })

  it('caps an automation at 5 AI steps', () => {
    const five: S[] = Array.from({ length: MAX_AI_STEPS_PER_RUN }, () => summarize())
    expect(validateStepsForActivation(five)).toEqual([])
    const six = [...five, summarize()]
    expect(messages(validateStepsForActivation(six))).toEqual([expect.stringContaining('at most 5 AI steps (this one has 6)')])
  })

  it('counts AI steps inside branches, and Ask AI and AI-written tickets too', () => {
    const steps: S[] = [
      { ...ask(), branches: { yes: [summarize(), summarize()], no: [summarize()] } },
      { step_type: 'create_ticket', step_config: { subject: 's', ai_write: true } },
      summarize(),
    ]
    expect(countAiSteps(steps)).toBe(6)
    expect(validateStepsForActivation(steps).some((i) => /at most 5/.test(i.message))).toBe(true)
  })

  it('refuses activation while AI is not set up, with a clear message; drafts are not checked here', () => {
    const steps = [reply()]
    const issues = validateStepsForActivation(steps, { aiSetup: { ok: false, message: 'AI is not set up. Open AI Agents > Setup.' } })
    expect(issues).toEqual([{ path: 'steps.ai', message: 'AI is not set up. Open AI Agents > Setup.' }])
    // A default message when the caller gave none.
    expect(messages(validateStepsForActivation(steps, { aiSetup: { ok: false } }))[0]).toMatch(/AI is not set up/)
  })

  it('does not ask about AI setup for an automation without AI steps', () => {
    const plain: S[] = [{ step_type: 'send_message', step_config: { text: 'hi' } }]
    expect(validateStepsForActivation(plain, { aiSetup: { ok: false } })).toEqual([])
    expect(stepsUseAi(plain)).toBe(false)
    expect(stepsUseAi([ask()])).toBe(true)
  })

  it('Ask AI needs its question', () => {
    expect(messages(validateStepsForActivation([ask({ operand: ' ' })]))).toContain('the question for Ask AI is required')
    // The other condition subjects keep their message.
    expect(messages(validateStepsForActivation([{ step_type: 'condition', step_config: { subject: 'tag_presence', operand: '' } }]))).toContain('condition operand is required')
  })

  it('checks the messages count, on-failure choices and the fallback text', () => {
    expect(messages(validateStepsForActivation([ask({ ai_messages: 31 })])).join()).toMatch(/1 to 30/)
    expect(messages(validateStepsForActivation([ask({ ai_messages: 0 })])).join()).toMatch(/1 to 30/)
    expect(messages(validateStepsForActivation([ask({ on_failure: 'explode' })])).join()).toMatch(/"no" or "stop"/)
    expect(messages(validateStepsForActivation([reply({ on_failure: 'fallback' })])).join()).toMatch(/fallback text is required/)
    expect(messages(validateStepsForActivation([reply({ on_failure: 'nope' })])).join()).toMatch(/on failure must be one of/)
    expect(messages(validateStepsForActivation([{ step_type: 'ai_summarize', step_config: { on_failure: 'fallback' } }])).join()).toMatch(/one of: stop, skip/)
    expect(messages(validateStepsForActivation([reply({ mode: 'shout' })])).join()).toMatch(/mode/)
  })

  it('AI extract: field rules', () => {
    const extract = (fields: unknown, extra: Record<string, unknown> = {}): S => ({ step_type: 'ai_extract', step_config: { fields, ...extra } })
    expect(validateStepsForActivation([extract([])]).length).toBeGreaterThan(0)
    const nine = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, type: 'text', description: 'd' }))
    expect(messages(validateStepsForActivation([extract(nine)])).join()).toMatch(/at most 8 fields/)
    expect(messages(validateStepsForActivation([extract([{ key: 'c', type: 'choice', description: 'd', choices: [] }])])).join()).toMatch(/needs choices/)
    expect(messages(validateStepsForActivation([extract([{ key: 'ok', type: 'text', description: 'd' }], { ai_messages: 50 })])).join()).toMatch(/1 to 30/)
  })

  it('AI translate needs a target language; Create ticket needs a subject and valid options', () => {
    expect(messages(validateStepsForActivation([{ step_type: 'ai_translate', step_config: {} }]))).toContain('a language to translate into is required')
    expect(messages(validateStepsForActivation([{ step_type: 'create_ticket', step_config: {} }]))).toContain('ticket subject is required')
    expect(messages(validateStepsForActivation([{ step_type: 'create_ticket', step_config: { subject: 's', category: 'x', priority: 'y' } }]))).toEqual([
      'a valid ticket type is required',
      'a valid priority is required',
    ])
  })

  it('validates the steps under an AI reply\'s Answered / Couldn\'t answer columns', () => {
    const steps: S[] = [{ ...reply(), branches: { yes: [], no: [{ step_type: 'add_tag', step_config: { tag_id: '' } }] } }]
    expect(validateStepsForActivation(steps)).toEqual([{ path: 'steps[0].no.steps[0].tag_id', message: 'tag is required' }])
  })
})

describe('validation: the conversation_closed trigger', () => {
  it('needs no configuration', () => {
    expect(validateTriggerForActivation('conversation_closed', {})).toEqual([])
    expect(validateTriggerForActivation('conversation_closed', undefined)).toEqual([])
  })
})
