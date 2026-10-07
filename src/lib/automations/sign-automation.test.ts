import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { PlacedField } from '@/lib/sign/pdf/types'
import type { SignRole } from '@/lib/sign/types'
import type { SignDocumentEventTriggerConfig } from '@/types'
import { interpolatePlain, interpolateSafe } from './ai/parsers'
import { varsProducedBy, variablesFor } from './ai/vars'
import { AUTOMATION_TEMPLATES } from './templates'
import { MAX_SIGN_CHAIN_DEPTH, eventsOf, getSignChainDepth, isSignEventName, signEventMatches, SIGN_EVENT_NAMES, type SignEventContext } from './sign-event'
import { checkSendSignDocument, copiesOf, isCopyRecipient, recipientsOf, requiredRoleKeys, signersOf, type SignSetup } from './sign-step'
import { signSetupForActivation, signTemplateIdsOf, stepsUseSign } from './sign-activation'
import { validateStepsForActivation, validateTriggerForActivation } from './validate'
import { triggerMeta, isKnownTrigger } from './trigger-meta'
import { planCreateTicket } from './ai/create-ticket'
import { fakeAi, fakeDb } from './ai/test-helpers'

const sign = (over: Partial<SignEventContext> = {}): SignEventContext => ({
  document_id: 'doc-1',
  reference: 'SIGN-2026-0001',
  title: 'Merchant Application',
  status: 'completed',
  event: 'completed',
  template: 'Merchant Application',
  template_id: 'tpl-1',
  category_id: 'cat-1',
  final_sha256: 'a'.repeat(64),
  verify_url: 'https://halo.example/verify/doc-1',
  ...over,
})

describe('sign_document_event: which events fire it', () => {
  it('no events chosen (or none valid) means completed only', () => {
    expect(eventsOf(undefined)).toEqual(['completed'])
    expect(eventsOf({})).toEqual(['completed'])
    expect(eventsOf({ events: [] })).toEqual(['completed'])
    expect(eventsOf({ events: ['nonsense' as never] })).toEqual(['completed'])
    expect(signEventMatches({}, sign())).toBe(true)
    expect(signEventMatches({}, sign({ event: 'sent', status: 'sent' }))).toBe(false)
    expect(signEventMatches(undefined, sign({ event: 'declined' }))).toBe(false)
  })

  it('fires for each chosen event and only those', () => {
    const cfg: SignDocumentEventTriggerConfig = { events: ['sent', 'declined'] }
    for (const e of SIGN_EVENT_NAMES) expect(signEventMatches(cfg, sign({ event: e })), e).toBe(e === 'sent' || e === 'declined')
  })

  it('can be narrowed to one template and one category; an empty filter means any', () => {
    expect(signEventMatches({ template_id: 'tpl-1' }, sign())).toBe(true)
    expect(signEventMatches({ template_id: 'tpl-2' }, sign())).toBe(false)
    expect(signEventMatches({ category_id: 'cat-1' }, sign())).toBe(true)
    expect(signEventMatches({ category_id: 'cat-9' }, sign())).toBe(false)
    expect(signEventMatches({ template_id: '', category_id: null }, sign())).toBe(true)
    expect(signEventMatches({ template_id: 'tpl-1', category_id: 'cat-9' }, sign())).toBe(false)
    // a document made from no template never matches a template filter
    expect(signEventMatches({ template_id: 'tpl-1' }, sign({ template_id: '' }))).toBe(false)
  })

  it('a dispatch without a document never matches', () => {
    expect(signEventMatches({ events: ['completed'] }, undefined)).toBe(false)
  })

  it('knows the six events, and the trigger has its pill', () => {
    expect([...SIGN_EVENT_NAMES]).toEqual(['sent', 'viewed', 'completed', 'declined', 'expired', 'voided'])
    expect(isSignEventName('viewed')).toBe(true)
    expect(isSignEventName('opened')).toBe(false)
    expect(isKnownTrigger('sign_document_event')).toBe(true)
    expect(triggerMeta('sign_document_event').pillClass).toContain('indigo')
  })
})

describe('the loop guard', () => {
  it('reads the depth from vars._sign_chain_depth, 0 when missing or odd', () => {
    expect(getSignChainDepth(undefined)).toBe(0)
    expect(getSignChainDepth({})).toBe(0)
    expect(getSignChainDepth({ _sign_chain_depth: 2 })).toBe(2)
    expect(getSignChainDepth({ _sign_chain_depth: -1 })).toBe(0)
    expect(getSignChainDepth({ _sign_chain_depth: 'x' })).toBe(0)
    expect(MAX_SIGN_CHAIN_DEPTH).toBe(3)
  })
})

describe('{{ sign.* }} and {{ contact.* }} in text', () => {
  const scope = {
    contact: { name: 'Casey Lee', first_name: 'Casey', email: 'casey@example.com', phone: '+60123456789', company: 'Kedai Casey' },
    sign: { reference: 'SIGN-2026-0001', template: 'Merchant Application', event: 'completed', final_sha256: 'ab12', verify_url: 'https://h.example/verify/x' },
    vars: { sign_document_id: 'doc-1' },
  }
  it('fills the sign namespace and the contact namespace', () => {
    expect(interpolatePlain('Hi {{ contact.first_name }} ({{contact.company}}): {{ sign.reference }} / {{ sign.template }} / {{ sign.event }}', scope)).toBe(
      'Hi Casey (Kedai Casey): SIGN-2026-0001 / Merchant Application / completed',
    )
    expect(interpolatePlain('{{ sign.verify_url }} {{ sign.final_sha256 }} {{ vars.sign_document_id }}', scope)).toBe('https://h.example/verify/x ab12 doc-1')
  })
  it('an unknown sign name, or no sign context, is empty text', () => {
    expect(interpolatePlain('[{{ sign.nope }}][{{ sign.reference }}]', {})).toBe('[][]')
    expect(interpolatePlain('[{{ sign.nope }}]', scope)).toBe('[]')
  })
  it('the AI-safe variant wraps the values like the others', () => {
    expect(interpolateSafe('{{ sign.reference }}', scope)).toBe('«SIGN-2026-0001»')
  })
})

describe('the Insert variable list', () => {
  it('offers the sign variables for the Secure Sign trigger only', () => {
    const steps = [{ cid: 'a', step_type: 'send_message', step_config: {} }]
    const on = variablesFor(steps, 'a', { triggerType: 'sign_document_event' }).map((v) => v.token)
    expect(on).toEqual(expect.arrayContaining(['{{ sign.document_id }}', '{{ sign.reference }}', '{{ sign.title }}', '{{ sign.status }}', '{{ sign.event }}', '{{ sign.template }}', '{{ sign.final_sha256 }}']))
    expect(variablesFor(steps, 'a', { triggerType: 'new_message_received' }).map((v) => v.token).some((t) => t.includes('sign.'))).toBe(false)
  })
  it('a Send document for signing step produces the document id and reference for the steps after it', () => {
    expect(varsProducedBy({ step_type: 'send_sign_document', step_config: {} })).toEqual(['sign_document_id', 'sign_reference'])
    const steps = [
      { cid: 's', step_type: 'send_sign_document', step_config: {} },
      { cid: 'm', step_type: 'send_message', step_config: {} },
    ]
    const tokens = variablesFor(steps, 'm').map((v) => v.token)
    expect(tokens).toContain('{{ vars.sign_document_id }}')
    expect(tokens).toContain('{{ vars.sign_reference }}')
    expect(variablesFor(steps, 's').map((v) => v.token)).not.toContain('{{ vars.sign_document_id }}')
  })
})

describe('validating the trigger', () => {
  it('accepts no configuration, valid events, and filters', () => {
    expect(validateTriggerForActivation('sign_document_event', {})).toEqual([])
    expect(validateTriggerForActivation('sign_document_event', { events: ['completed', 'declined'], template_id: 'x', category_id: null })).toEqual([])
  })
  it('refuses an unknown event, a non-list, and a non-text filter', () => {
    expect(validateTriggerForActivation('sign_document_event', { events: ['opened'] }).map((i) => i.path)).toEqual(['trigger.events'])
    expect(validateTriggerForActivation('sign_document_event', { events: 'completed' }).map((i) => i.path)).toEqual(['trigger.events'])
    expect(validateTriggerForActivation('sign_document_event', { template_id: 5 }).map((i) => i.path)).toEqual(['trigger.template_id'])
  })
  it('refuses a workspace where Secure Sign is off, when the caller looked', () => {
    const off: SignSetup = { enabled: false, templates: {} }
    expect(validateTriggerForActivation('sign_document_event', {}, { signSetup: off }).map((i) => i.message)).toEqual([expect.stringContaining('not turned on')])
    expect(validateTriggerForActivation('sign_document_event', {}, { signSetup: { enabled: true, templates: {} } })).toEqual([])
  })
})

const goodStep = () => ({
  step_type: 'send_sign_document',
  step_config: {
    template_id: 'tpl-1',
    recipients: [{ role_key: 'merchant', source: 'contact', channel: 'email' }],
    merge_values: { company: '{{ contact.company }}' },
    send: true,
  },
})

const setup = (over: Partial<SignSetup['templates'][string]> = {}, enabled = true): SignSetup => ({
  enabled,
  templates: {
    'tpl-1': {
      found: true,
      active: true,
      roles: [
        { key: 'merchant', kind: 'signer', label: 'Merchant' },
        { key: 'director', kind: 'signer', label: 'Director (countersign)' },
        { key: 'finance', kind: 'filler', label: 'Finance contact' },
      ],
      requiredRoles: ['merchant'],
      ...over,
    },
  },
})

describe('validating the Send document for signing step', () => {
  const issues = (c: Record<string, unknown>, s?: SignSetup) => validateStepsForActivation([{ step_type: 'send_sign_document', step_config: c }], { signSetup: s })

  it('a complete step is valid, with or without the workspace lookup', () => {
    expect(issues(goodStep().step_config)).toEqual([])
    expect(issues(goodStep().step_config, setup())).toEqual([])
  })

  it('needs a template and at least one recipient', () => {
    expect(issues({ ...goodStep().step_config, template_id: '  ' }).map((i) => i.path)).toEqual(['steps[0].template_id'])
    expect(issues({ ...goodStep().step_config, recipients: [] }).map((i) => i.path)).toEqual(['steps[0].recipients'])
    expect(issues({ template_id: 'tpl-1' }).map((i) => i.path)).toEqual(['steps[0].recipients'])
  })

  it('checks each recipient: a role, a source, a channel; a fixed person needs a name and a valid email', () => {
    const r = issues({ ...goodStep().step_config, recipients: [{ role_key: '', source: 'nobody', channel: 'sms' }] }).map((i) => i.path)
    expect(r).toEqual(expect.arrayContaining(['steps[0].recipients[0].role_key', 'steps[0].recipients[0].source', 'steps[0].recipients[0].channel']))
    const fixed = (extra: Record<string, unknown>) => issues({ ...goodStep().step_config, recipients: [{ role_key: 'merchant', source: 'fixed', channel: 'email', ...extra }] }).map((i) => i.path)
    expect(fixed({})).toEqual(['steps[0].recipients[0].full_name', 'steps[0].recipients[0].email'])
    expect(fixed({ full_name: 'A', email: 'not-an-email' })).toEqual(['steps[0].recipients[0].email'])
    expect(fixed({ full_name: 'A', email: 'a@b.my' })).toEqual([])
    // a variable in the address is checked when it runs
    expect(fixed({ full_name: 'A', email: '{{ contact.email }}' })).toEqual([])
    expect(
      issues({ ...goodStep().step_config, recipients: [{ role_key: 'merchant', source: 'fixed', channel: 'whatsapp', full_name: 'A', email: 'a@b.my' }] }).map((i) => i.path),
    ).toEqual(['steps[0].recipients[0].phone'])
  })

  it('merge field names are held to the same pattern a draft uses, and values are text', () => {
    expect(issues({ ...goodStep().step_config, merge_values: { ok_1: 'x', 'bad key': 'y', '1st': 'z', fw_no: 5 } }).map((i) => i.path)).toEqual([
      'steps[0].merge_values.bad key',
      'steps[0].merge_values.1st',
      'steps[0].merge_values.fw_no',
    ])
    expect(issues({ ...goodStep().step_config, merge_values: { a: 'x'.repeat(2001) } }).map((i) => i.path)).toEqual(['steps[0].merge_values.a'])
    expect(issues({ ...goodStep().step_config, merge_values: [] }).map((i) => i.path)).toEqual(['steps[0].merge_values'])
    expect(checkSendSignDocument({ ...goodStep().step_config, merge_values: { 'a.b': 'x' } }, 'p')).toEqual([])
  })

  it('send and language are checked', () => {
    expect(issues({ ...goodStep().step_config, send: 'yes' }).map((i) => i.path)).toEqual(['steps[0].send'])
    expect(issues({ ...goodStep().step_config, locale: 'fr' }).map((i) => i.path)).toEqual(['steps[0].locale'])
    expect(issues({ ...goodStep().step_config, locale: 'ms', send: false })).toEqual([])
  })

  it('with the workspace lookup: Secure Sign on, the template there and active, the roles covered', () => {
    expect(issues(goodStep().step_config, setup({}, false)).map((i) => i.message)).toEqual([expect.stringContaining('not turned on')])
    expect(issues(goodStep().step_config, { enabled: true, templates: { 'tpl-1': { found: false, active: false, roles: [], requiredRoles: [] } } }).map((i) => i.message)).toEqual([
      expect.stringContaining('no longer exists'),
    ])
    expect(issues(goodStep().step_config, setup({ active: false })).map((i) => i.message)).toEqual([expect.stringContaining('not active')])
    // a recipient for a role the template does not have
    expect(issues({ ...goodStep().step_config, recipients: [{ role_key: 'merchant', source: 'contact', channel: 'email' }, { role_key: 'ghost', source: 'contact', channel: 'email' }] }, setup()).map((i) => i.path)).toEqual([
      'steps[0].recipients[1].role_key',
    ])
    // every required role needs a person
    const needTwo = setup({ requiredRoles: ['merchant', 'director'] })
    expect(issues(goodStep().step_config, needTwo).map((i) => i.message)).toEqual([expect.stringContaining('Director (countersign)')])
    expect(
      issues({ ...goodStep().step_config, recipients: [{ role_key: 'merchant', source: 'contact', channel: 'email' }, { role_key: 'director', source: 'fixed', channel: 'email', full_name: 'D', email: 'd@x.my' }] }, needTwo),
    ).toEqual([])
  })

  it('is found inside a Condition branch too', () => {
    const steps = [{ step_type: 'condition', step_config: { subject: 'tag_presence', operand: 't' }, branches: { yes: [{ step_type: 'send_sign_document', step_config: {} }] } }]
    expect(validateStepsForActivation(steps).map((i) => i.path)).toEqual(expect.arrayContaining(['steps[0].yes.steps[0].template_id']))
    expect(stepsUseSign(steps)).toBe(true)
    expect(signTemplateIdsOf([{ step_type: 'send_sign_document', step_config: { template_id: ' t1 ' } }, { step_type: 'condition', step_config: {}, branches: { no: [{ step_type: 'send_sign_document', step_config: { template_id: 't2' } }, { step_type: 'send_sign_document', step_config: { template_id: 't1' } }] } }])).toEqual(['t1', 't2'])
  })
})

describe('which roles a template cannot be sent without', () => {
  const roles: SignRole[] = [
    { key: 'merchant', label: 'Merchant', kind: 'signer', color: 0 },
    { key: 'finance', label: 'Finance', kind: 'filler', color: 1 },
    { key: 'director', label: 'Director', kind: 'signer', color: 2 },
  ]
  const f = (key: string, role: string, type: PlacedField['type'], extra: Partial<PlacedField> = {}) => ({ key, role, type, page: 1, x: 0, y: 0, w: 0.2, h: 0.05, ...extra }) as PlacedField
  it('a role with something to sign or fill is required; fixed text and merge fields do not count', () => {
    const fields = [f('s1', 'merchant', 'signature'), f('t1', 'sender', 'static_text'), f('m1', 'finance', 'static_text', { merge: 'fw_no' })]
    expect(requiredRoleKeys({ roles, fields })).toEqual(['merchant'])
  })
  it('a role with a part of the form is required too', () => {
    const fields = [f('s1', 'merchant', 'signature'), f('d1', 'director', 'signature')]
    const form = { version: 1, parts: [{ key: 'bank', role: 'finance', title: { en: 'Bank' } }], fields: [] } as never
    expect(requiredRoleKeys({ roles, fields, form })).toEqual(['merchant', 'finance', 'director'])
  })
})

describe('the activation lookup', () => {
  // a minimal client: answers each table with the rows it is given
  const client = (tables: Record<string, Record<string, unknown> | null>) => {
    const make = (table: string) => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) q[m] = () => q
      q.maybeSingle = async () => ({ data: tables[table] ?? null, error: null })
      return q
    }
    return { from: make } as never
  }

  it('does not look at Secure Sign at all when the automation does not use it', async () => {
    expect(await signSetupForActivation(client({}), 'a1', [{ step_type: 'send_message' }], 'new_message_received')).toBeUndefined()
  })
})

describe('the recipes', () => {
  it('Merchant onboarding: the tag trigger, then Send document for signing', () => {
    const t = AUTOMATION_TEMPLATES.merchant_onboarding
    expect(t.trigger_type).toBe('tag_added')
    expect(t.trigger_config).toMatchObject({ tag_id: '', tag_hint: 'Merchant applicant' })
    expect(t.steps.map((s) => s.step_type)).toEqual(['send_sign_document'])
    expect(t.steps[0].step_config).toMatchObject({ template_hint: 'Merchant Application', recipients: [{ role_key: 'merchant', source: 'contact', channel: 'email' }], send: true })
  })

  it('Merchant signed follow-up: the completed trigger, a tag, a KYC ticket, a thank-you last', () => {
    const t = AUTOMATION_TEMPLATES.merchant_signed_followup
    expect(t.trigger_type).toBe('sign_document_event')
    expect(eventsOf(t.trigger_config as SignDocumentEventTriggerConfig)).toEqual(['completed'])
    expect(t.steps.map((s) => s.step_type)).toEqual(['add_tag', 'create_ticket', 'send_message'])
    expect(t.steps[0].step_config).toMatchObject({ tag_hint: 'Merchant signed' })
    expect(t.steps[1].step_config).toMatchObject({ subject: 'Merchant KYC review', skip_if_open: false })
  })

  it('each recipe is valid once its pickers are filled, and invalid before (drafts save fine)', () => {
    const filled = (slug: 'merchant_onboarding' | 'merchant_signed_followup') => {
      const t = AUTOMATION_TEMPLATES[slug]
      return {
        trigger: { ...(t.trigger_config as Record<string, unknown>), tag_id: 'tag-1', template_id: 'tpl-1' },
        steps: t.steps.map((s) => ({
          step_type: s.step_type as string,
          step_config: { ...(s.step_config as Record<string, unknown>), ...(s.step_type === 'add_tag' ? { tag_id: 'tag-1' } : {}), ...(s.step_type === 'send_sign_document' ? { template_id: 'tpl-1' } : {}) },
        })),
      }
    }
    for (const slug of ['merchant_onboarding', 'merchant_signed_followup'] as const) {
      const t = AUTOMATION_TEMPLATES[slug]
      const f = filled(slug)
      expect(validateTriggerForActivation(t.trigger_type, f.trigger), slug).toEqual([])
      expect(validateStepsForActivation(f.steps, { signSetup: setup({ requiredRoles: ['merchant'] }) }), slug).toEqual([])
      expect(validateStepsForActivation(t.steps.map((s) => ({ step_type: s.step_type as string, step_config: s.step_config as Record<string, unknown> }))).length, slug).toBeGreaterThan(0)
    }
  })

  it('the catalogue carries the recipe names, descriptions and seeds in all four languages, with the same tokens', () => {
    for (const loc of ['en', 'ms', 'zh', 'ko']) {
      const tpl = JSON.parse(readFileSync(join(process.cwd(), 'messages', `${loc}.json`), 'utf8')).Automations.templates
      for (const slug of ['merchant_onboarding', 'merchant_signed_followup']) {
        expect(tpl[slug].name, `${loc}.${slug}`).toBeTruthy()
        expect(tpl[slug].description, `${loc}.${slug}`).toBeTruthy()
      }
      const seed = tpl.merchant_signed_followup.seed
      expect(seed.ticketSubject).toBeTruthy()
      expect(seed.ticketDescription).toContain('{{ sign.reference }}')
      expect(seed.ticketDescription).toContain('{{ sign.verify_url }}')
      expect(seed.welcomeMessage).toContain('{{ contact.name }}')
      expect(seed.welcomeMessage).toContain('{{ sign.reference }}')
    }
  })
})

describe('the KYC ticket of the follow-up recipe reads the document', () => {
  it('fills {{ sign.* }} and {{ contact.* }} in the subject and the description', async () => {
    const t = AUTOMATION_TEMPLATES.merchant_signed_followup.steps[1]
    const { db } = fakeDb({ contacts: [{ id: 'c1', account_id: 'a1', name: 'Casey Lee', email: 'c@x.my', company: 'Kedai Casey', phone: '+601' }] })
    const plan = await planCreateTicket(t.step_config as never, {
      db,
      ai: fakeAi([]),
      accountId: 'a1',
      automation: { id: 'auto', name: 'Merchant signed' },
      conversationId: null,
      contactId: 'c1',
      vars: {},
      sign: { ...sign() },
      dryRun: true,
    })
    expect(plan.subject).toBe('Merchant KYC review')
    expect(plan.description).toContain('SIGN-2026-0001')
    expect(plan.description).toContain('Casey Lee')
    expect(plan.description).toContain('https://halo.example/verify/doc-1')
    expect(plan.description).not.toContain('{{')
    expect(plan.skip).toBeNull()
  })
})

describe('the Send document for signing step: people who receive a copy', () => {
  const signer = { role_key: 'merchant', source: 'contact', channel: 'email' }
  const copy = (extra: Record<string, unknown> = {}) => ({ kind: 'copy', role_key: '', source: 'fixed', channel: 'email', full_name: 'Accounts', email: 'accounts@kedai.my', ...extra })
  const paths = (recipients: unknown[], s?: SignSetup) =>
    checkSendSignDocument({ ...goodStep().step_config, recipients }, 'p', s).map((i) => i.path.replace(/^p\./, ''))

  it('a recipient with no kind is a signer: every configuration saved before copies existed reads as before', () => {
    const old = [signer, { role_key: 'director', source: 'fixed', channel: 'email', full_name: 'D', email: 'd@x.my' }]
    expect(signersOf({ recipients: old as never })).toHaveLength(2)
    expect(copiesOf({ recipients: old as never })).toEqual([])
    expect(paths(old)).toEqual([])
    expect(paths([{ ...signer, kind: 'signer' }])).toEqual([])
  })

  it('recipientsOf keeps everyone, signersOf and copiesOf split them, and junk entries are dropped', () => {
    const cfg = { recipients: [signer, copy(), null, 'x', copy({ source: 'contact' })] as never }
    expect(recipientsOf(cfg)).toHaveLength(3)
    expect(signersOf(cfg)).toEqual([signer])
    expect(copiesOf(cfg)).toHaveLength(2)
    expect(isCopyRecipient(copy() as never)).toBe(true)
    expect(isCopyRecipient(signer as never)).toBe(false)
    expect(recipientsOf({})).toEqual([])
  })

  it('a copy needs no role and no channel; a signer still does', () => {
    expect(paths([signer, copy()])).toEqual([])
    // role and channel left off altogether
    expect(paths([signer, { kind: 'copy', source: 'fixed', full_name: 'A', email: 'a@x.my' }])).toEqual([])
    expect(paths([{ ...signer, role_key: '' }, copy()])).toEqual(['recipients[0].role_key'])
  })

  it('a fixed copy needs a name and a valid email (a variable in the address is checked when it runs); a contact copy needs neither', () => {
    expect(paths([signer, copy({ full_name: '', email: '' })])).toEqual(['recipients[1].full_name', 'recipients[1].email'])
    expect(paths([signer, copy({ email: 'not-an-email' })])).toEqual(['recipients[1].email'])
    expect(paths([signer, copy({ email: '{{ vars.accounts }}' })])).toEqual([])
    expect(paths([{ ...signer, source: 'fixed', full_name: 'S', email: 's@x.my' }, copy({ source: 'contact', full_name: undefined, email: undefined })])).toEqual([])
    expect(paths([signer, copy({ source: 'nobody' })])).toEqual(['recipients[1].source'])
    // an unknown kind is not a copy: it is held to the rules of a signer as well
    expect(paths([signer, copy({ kind: 'cc' })])).toEqual(['recipients[1].kind', 'recipients[1].role_key'])
  })

  it('at least one recipient still means one who signs; the 20 cap counts signers, the copies have their own cap of 10', () => {
    expect(paths([copy()])).toEqual(['recipients'])
    const signers = (n: number) => Array.from({ length: n }, (_, i) => ({ role_key: 'merchant', source: 'fixed', channel: 'email', full_name: `S${i}`, email: `s${i}@x.my` }))
    const copies = (n: number) => Array.from({ length: n }, (_, i) => copy({ full_name: `C${i}`, email: `c${i}@x.my` }))
    expect(paths([...signers(20), ...copies(10)])).toEqual([])
    expect(paths(signers(21))).toEqual(['recipients'])
    expect(paths([...signers(1), ...copies(11)])).toEqual(['recipients'])
    expect(checkSendSignDocument({ ...goodStep().step_config, recipients: [...signers(1), ...copies(11)] }, 'p')[0].message).toContain('up to 10')
  })

  it('the same fixed address as a signer or as another copy is refused, whatever its case; {{variables}} are not compared', () => {
    const fixedSigner = { role_key: 'merchant', source: 'fixed', channel: 'email', full_name: 'S', email: 'Aziz@Kedai.my' }
    expect(paths([fixedSigner, copy({ email: 'aziz@kedai.my' })])).toEqual(['recipients[1].email'])
    expect(paths([signer, copy({ email: 'x@kedai.my' }), copy({ full_name: 'B', email: 'X@KEDAI.MY' })])).toEqual(['recipients[2].email'])
    expect(paths([signer, copy({ email: '{{ vars.a }}' }), copy({ full_name: 'B', email: '{{ vars.a }}' })])).toEqual([])
    // the contact is one address: they cannot sign and also receive a copy, nor be a copy twice
    expect(paths([signer, copy({ source: 'contact' })])).toEqual(['recipients[1].source'])
    expect(paths([{ ...fixedSigner, email: 's@x.my' }, copy({ source: 'contact' }), copy({ source: 'contact' })])).toEqual(['recipients[2].source'])
  })

  it('with the workspace lookup, the template roles are the signers: a copy needs no role and covers none', () => {
    expect(paths([signer, copy()], setup())).toEqual([])
    // a copy never covers a required role
    expect(paths([{ ...signer, role_key: 'finance' }, copy({ role_key: 'merchant' })], setup())).toEqual(['recipients'])
    // a role key on a copy is not looked up in the template
    expect(paths([signer, copy({ role_key: 'ghost' })], setup())).toEqual([])
    expect(paths([signer, { ...signer, role_key: 'ghost' }], setup())).toEqual(['recipients[1].role_key'])
  })

  it('goes through the activation validator like any other step', () => {
    const v = (recipients: unknown[]) => validateStepsForActivation([{ step_type: 'send_sign_document', step_config: { ...goodStep().step_config, recipients } }]).map((i) => i.path)
    expect(v([signer, copy()])).toEqual([])
    expect(v([copy()])).toEqual(['steps[0].recipients'])
  })
})
