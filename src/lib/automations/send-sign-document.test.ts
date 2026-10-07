import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeDb } from '@/lib/sign/service/fake-db'
import { SignError } from '@/lib/sign/service/errors'
import type { SignCtx } from '@/lib/sign/service/context'
import type { SendSignDocumentStepConfig } from '@/types'

// The step reuses the Doc Sign services; here they are replaced by recorders so the step's own decisions can be
// seen: who is put on the document, what is asked of the services, what happens when Doc Sign says no.
const m = vi.hoisted(() => ({
  enabled: true,
  createDraftFromTemplate: vi.fn(),
  updateDraft: vi.fn(),
  setSigners: vi.fn(),
  setCopyRecipients: vi.fn(),
  deleteDraft: vi.fn(),
  sendDocument: vi.fn(),
  origin: 'https://halo.example',
  admin: { marker: 'admin' } as unknown,
}))

vi.mock('@/lib/sign/feature', () => ({ signEnabled: async () => m.enabled }))
vi.mock('@/lib/sign/service/drafts', () => ({
  createDraftFromTemplate: (...a: unknown[]) => m.createDraftFromTemplate(...a),
  updateDraft: (...a: unknown[]) => m.updateDraft(...a),
  setSigners: (...a: unknown[]) => m.setSigners(...a),
  deleteDraft: (...a: unknown[]) => m.deleteDraft(...a),
}))
vi.mock('@/lib/sign/service/copy-recipients', () => ({ setCopyRecipients: (...a: unknown[]) => m.setCopyRecipients(...a) }))
vi.mock('./admin-client', () => ({ supabaseAdmin: () => m.admin }))
vi.mock('@/lib/site-url', () => ({ publicOrigin: () => m.origin }))
vi.mock('@/lib/sign/notify', () => ({ realDeps: { marker: 'deps' } }))
vi.mock('@/lib/sign/service/send', () => ({ sendDocument: (...a: unknown[]) => m.sendDocument(...a) }))

import { docKey, runSendSignDocument, type SendSignDocumentInput } from './send-sign-document'

const ACCOUNT = 'acct-1'
const TEMPLATE = 'tpl-1'
const CONTACT = 'c1'

let db: FakeDb
let ctx: SignCtx

const draft = (over: Record<string, unknown> = {}) => ({
  id: 'doc-1',
  account_id: ACCOUNT,
  status: 'draft',
  reference: null,
  contact_id: CONTACT,
  roles_snapshot: [
    { key: 'merchant', label: 'Merchant', kind: 'signer', color: 0 },
    { key: 'finance', label: 'Finance', kind: 'filler', color: 1 },
  ],
  ...over,
})

const cfg = (over: Partial<SendSignDocumentStepConfig> = {}): SendSignDocumentStepConfig => ({
  template_id: TEMPLATE,
  title: 'Application: {{ contact.company }}',
  recipients: [{ role_key: 'merchant', source: 'contact', channel: 'email' }],
  merge_values: { company: '{{ contact.company }}', fw_no: 'FW-{{ vars.n }}' },
  send: true,
  ...over,
})

const subst = (s: string) => s.replace('{{ contact.company }}', 'Kedai Casey').replace('{{ vars.n }}', '42')

const input = (over: Partial<SendSignDocumentInput> = {}): SendSignDocumentInput => ({
  cfg: cfg(),
  accountId: ACCOUNT,
  ownerUserId: 'owner-1',
  automation: { id: 'a1', name: 'Merchant onboarding' },
  contactId: CONTACT,
  contact: { name: 'Casey Lee', email: 'casey@example.com', phone: '+60123456789', company: 'Kedai Casey' },
  vars: {},
  text: subst,
  ctx,
  ...over,
})

beforeEach(() => {
  db = new FakeDb()
  ctx = { admin: db.client(), accountId: ACCOUNT, userId: 'owner-1', origin: 'https://halo.example', deps: {} as never, now: () => new Date('2026-10-07T00:00:00Z'), chainDepth: 2 }
  m.enabled = true
  for (const f of [m.createDraftFromTemplate, m.updateDraft, m.setSigners, m.setCopyRecipients, m.deleteDraft, m.sendDocument]) f.mockReset()
  m.createDraftFromTemplate.mockImplementation(async () => {
    const d = draft()
    db.seed('sign_documents', [d])
    return d
  })
  m.updateDraft.mockImplementation(async (_c: unknown, _id: string, patch: Record<string, unknown>) => ({ ...draft(), ...patch }))
  m.setSigners.mockResolvedValue([])
  m.setCopyRecipients.mockResolvedValue([])
  m.deleteDraft.mockResolvedValue(undefined)
  m.sendDocument.mockResolvedValue({ documentId: 'doc-1', reference: 'SIGN-2026-0003', expiresAt: '2026-11-07T00:00:00Z', invited: [{ signerId: 's1', name: 'Casey Lee', roleKey: 'merchant', delivery: { status: 'sent', channel: 'email' } }] })
})

describe('Send document for signing: the happy path', () => {
  it('makes the draft from the template for the contact, fills it, sets the people, sends it', async () => {
    const out = await runSendSignDocument(input())
    expect(m.createDraftFromTemplate).toHaveBeenCalledWith(ctx, { templateId: TEMPLATE, contactId: CONTACT, title: 'Application: Kedai Casey' })
    // the merge values go through the engine's interpolation
    expect(m.updateDraft).toHaveBeenCalledWith(ctx, 'doc-1', { mergeValues: { company: 'Kedai Casey', fw_no: 'FW-42' } })
    expect(m.setSigners).toHaveBeenCalledWith(ctx, 'doc-1', [{ roleKey: 'merchant', kind: 'signer', fullName: 'Casey Lee', email: 'casey@example.com', phone: '+60123456789', channel: 'email', orderNo: 1 }])
    expect(m.sendDocument).toHaveBeenCalledWith(ctx, 'doc-1')
    expect(out.step).toMatchObject({ status: 'success', outcome: 'sent' })
    expect(out.step.detail).toContain('SIGN-2026-0003')
    // for the steps after it
    expect(out.varsPatch).toMatchObject({ sign_document_id: 'doc-1', sign_reference: 'SIGN-2026-0003', _sign_doc_key: docKey(CONTACT, TEMPLATE) })
  })

  it('send off: the document stays a draft for a person', async () => {
    const out = await runSendSignDocument(input({ cfg: cfg({ send: false }) }))
    expect(m.sendDocument).not.toHaveBeenCalled()
    expect(out.step).toMatchObject({ status: 'success', outcome: 'draft' })
    expect(out.varsPatch.sign_document_id).toBe('doc-1')
  })

  it('a message and a language are put on the draft; a title left empty is the template\'s own', async () => {
    await runSendSignDocument(input({ cfg: cfg({ title: '', message: 'Please sign, {{ contact.company }}', locale: 'ms', merge_values: {} }) }))
    expect(m.createDraftFromTemplate).toHaveBeenCalledWith(ctx, { templateId: TEMPLATE, contactId: CONTACT, title: undefined })
    expect(m.updateDraft).toHaveBeenCalledWith(ctx, 'doc-1', { message: 'Please sign, Kedai Casey', locale: 'ms' })
  })

  it('a fixed recipient takes its details from the step, with variables filled in; the role decides the kind', async () => {
    await runSendSignDocument(
      input({
        cfg: cfg({
          recipients: [
            { role_key: 'merchant', source: 'contact', channel: 'email' },
            { role_key: 'finance', source: 'fixed', full_name: 'Finance of {{ contact.company }}', email: 'finance@kedai.my', phone: '0123456789', channel: 'whatsapp' },
          ],
        }),
      }),
    )
    const people = m.setSigners.mock.calls[0][2]
    expect(people).toEqual([
      expect.objectContaining({ roleKey: 'merchant', kind: 'signer', orderNo: 1 }),
      { roleKey: 'finance', kind: 'filler', fullName: 'Finance of Kedai Casey', email: 'finance@kedai.my', phone: '0123456789', channel: 'whatsapp', orderNo: 2 },
    ])
  })

  it('uses the owner of the automation and the chain depth it is part of (the context is not rebuilt here)', async () => {
    await runSendSignDocument(input())
    expect(m.sendDocument.mock.calls[0][0]).toMatchObject({ userId: 'owner-1', chainDepth: 2 })
  })

  it('builds its own context when none is given: the owner as author, the chain depth of the run, the public address', async () => {
    const out = await runSendSignDocument(input({ ctx: undefined, vars: { _sign_chain_depth: 2 } }))
    expect(out.step.outcome).toBe('sent')
    expect(m.sendDocument.mock.calls[0][0]).toMatchObject({ admin: m.admin, accountId: ACCOUNT, userId: 'owner-1', origin: 'https://halo.example', deps: { marker: 'deps' }, chainDepth: 2 })
  })

  it('without a public address the links cannot be made: skipped in words', async () => {
    m.origin = ''
    const out = await runSendSignDocument(input({ ctx: undefined }))
    m.origin = 'https://halo.example'
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'not_configured' })
    expect(m.createDraftFromTemplate).not.toHaveBeenCalled()
  })

  it('reports people who could not be reached', async () => {
    m.sendDocument.mockResolvedValue({ documentId: 'doc-1', reference: 'R1', expiresAt: 'x', invited: [{ signerId: 's', name: 'A', roleKey: 'merchant', delivery: { status: 'failed', channel: 'email' } }] })
    const out = await runSendSignDocument(input())
    expect(out.step.detail).toContain('1 could not be reached')
  })
})

describe('Send document for signing: Secure Sign says no', () => {
  it('a limit reached keeps the draft, links it for a person, and does not crash the run', async () => {
    m.sendDocument.mockRejectedValue(new SignError('sign_limit_reached', 'This workspace has reached its monthly limit.', 429))
    const out = await runSendSignDocument(input())
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'sign_limit_reached' })
    expect(out.step.detail).toContain('saved as a draft')
    expect(out.step.detail).toContain('sign_limit_reached')
    expect(out.varsPatch.sign_document_id).toBe('doc-1')
    expect(m.deleteDraft).not.toHaveBeenCalled()
  })

  it('not ready to send lists the problems in words', async () => {
    m.sendDocument.mockRejectedValue(new SignError('not_ready', 'This document is not ready to send.', 400, [{ code: 'role_without_person', role: 'director' }]))
    const out = await runSendSignDocument(input())
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'not_ready' })
    expect(out.step.detail).toContain('role_without_person:director')
  })

  it('a template that is not active is skipped, and nothing was made', async () => {
    m.createDraftFromTemplate.mockRejectedValue(new SignError('template_not_active', 'This template is not active.', 409))
    const out = await runSendSignDocument(input())
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'template_not_active' })
    expect(out.varsPatch).toEqual({})
    expect(m.deleteDraft).not.toHaveBeenCalled()
  })

  it('values the draft refuses remove the draft again, so retries do not pile drafts up', async () => {
    m.updateDraft.mockRejectedValue(new SignError('bad_merge_values', 'The values to fill in are not valid.', 400))
    const out = await runSendSignDocument(input())
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'bad_merge_values' })
    expect(m.deleteDraft).toHaveBeenCalledWith(ctx, 'doc-1')
    expect(m.sendDocument).not.toHaveBeenCalled()
  })

  it('a role the template does not have is skipped and the draft removed', async () => {
    const out = await runSendSignDocument(input({ cfg: cfg({ recipients: [{ role_key: 'ghost', source: 'contact', channel: 'email' }] }) }))
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'signer_role' })
    expect(m.deleteDraft).toHaveBeenCalled()
    expect(m.setSigners).not.toHaveBeenCalled()
  })

  it('an invalid recipient (the service refuses the address) is skipped, not thrown', async () => {
    m.setSigners.mockRejectedValue(new SignError('signer_email', 'Enter a valid email for person 1.', 400))
    const out = await runSendSignDocument(input())
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'signer_email' })
    expect(m.deleteDraft).toHaveBeenCalled()
  })

  it('an unexpected failure is thrown (the run fails like any other step)', async () => {
    m.createDraftFromTemplate.mockRejectedValue(new Error('connection reset'))
    await expect(runSendSignDocument(input())).rejects.toThrow('connection reset')
    m.sendDocument.mockRejectedValue(new Error('boom'))
    m.createDraftFromTemplate.mockImplementation(async () => draft())
    await expect(runSendSignDocument(input())).rejects.toThrow('boom')
  })
})

describe('Send document for signing: before anything is made', () => {
  it('Secure Sign off for the workspace: skipped', async () => {
    m.enabled = false
    const out = await runSendSignDocument(input())
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'not_enabled' })
    expect(m.createDraftFromTemplate).not.toHaveBeenCalled()
  })

  it('the contact has no email: skipped in words, no draft', async () => {
    const out = await runSendSignDocument(input({ contact: { name: 'Casey', email: '', phone: '+601' } }))
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'recipient_email_missing' })
    expect(out.step.detail).toContain('no email')
    expect(m.createDraftFromTemplate).not.toHaveBeenCalled()
  })

  it('WhatsApp to a contact with no phone: skipped', async () => {
    const out = await runSendSignDocument(input({ cfg: cfg({ recipients: [{ role_key: 'merchant', source: 'contact', channel: 'whatsapp' }] }), contact: { name: 'Casey', email: 'c@x.my', phone: '' } }))
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'recipient_phone_missing' })
  })

  it('a run with no contact cannot use the contact as a recipient', async () => {
    const out = await runSendSignDocument(input({ contactId: null, contact: null }))
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'no_contact' })
    // but a fixed recipient needs none, and the document is simply not linked to a contact
    const fixed = await runSendSignDocument(input({ contactId: null, contact: null, cfg: cfg({ recipients: [{ role_key: 'merchant', source: 'fixed', full_name: 'A B', email: 'ab@x.my', channel: 'email' }] }) }))
    expect(fixed.step.status).toBe('success')
    expect(m.createDraftFromTemplate).toHaveBeenLastCalledWith(ctx, expect.objectContaining({ contactId: null }))
  })

  it('a step without a template or recipients is a configuration error (thrown, like the other steps)', async () => {
    await expect(runSendSignDocument(input({ cfg: cfg({ template_id: '' }) }))).rejects.toThrow('needs a template')
    await expect(runSendSignDocument(input({ cfg: cfg({ recipients: [] }) }))).rejects.toThrow('at least one recipient')
  })
})

describe('Send document for signing: a retry of the same run', () => {
  it('does not make a second document when the run already made one that was sent', async () => {
    db.seed('sign_documents', [draft({ status: 'sent', reference: 'SIGN-2026-0003' })])
    const out = await runSendSignDocument(input({ vars: { sign_document_id: 'doc-1', _sign_doc_key: docKey(CONTACT, TEMPLATE) } }))
    expect(m.createDraftFromTemplate).not.toHaveBeenCalled()
    expect(m.sendDocument).not.toHaveBeenCalled()
    expect(out.step).toMatchObject({ status: 'success', outcome: 'already_sent' })
  })

  it('finishes a draft the first pass made but could not send (the limit was raised), without rebuilding it', async () => {
    db.seed('sign_documents', [draft()])
    const out = await runSendSignDocument(input({ vars: { sign_document_id: 'doc-1', _sign_doc_key: docKey(CONTACT, TEMPLATE) } }))
    expect(m.createDraftFromTemplate).not.toHaveBeenCalled()
    expect(m.setSigners).not.toHaveBeenCalled()
    expect(m.sendDocument).toHaveBeenCalledWith(ctx, 'doc-1')
    expect(out.step.outcome).toBe('sent')
  })

  it('another template or another contact in the same run is a different document', async () => {
    db.seed('sign_documents', [draft({ status: 'sent' })])
    await runSendSignDocument(input({ vars: { sign_document_id: 'doc-1', _sign_doc_key: docKey(CONTACT, 'other-template') } }))
    expect(m.createDraftFromTemplate).toHaveBeenCalledTimes(1)
  })

  it('a remembered document that is gone is made again', async () => {
    const out = await runSendSignDocument(input({ vars: { sign_document_id: 'gone', _sign_doc_key: docKey(CONTACT, TEMPLATE) } }))
    expect(m.createDraftFromTemplate).toHaveBeenCalledTimes(1)
    expect(out.step.outcome).toBe('sent')
  })

  it('the document of another workspace is never reused', async () => {
    db.seed('sign_documents', [draft({ id: 'doc-x', account_id: 'someone-else', status: 'sent' })])
    await runSendSignDocument(input({ vars: { sign_document_id: 'doc-x', _sign_doc_key: docKey(CONTACT, TEMPLATE) } }))
    expect(m.createDraftFromTemplate).toHaveBeenCalledTimes(1)
  })
})

describe('Send document for signing: people who receive a copy', () => {
  const copy = (over: Partial<SendSignDocumentStepConfig['recipients'][number]> = {}): SendSignDocumentStepConfig['recipients'][number] => ({ kind: 'copy', role_key: '', source: 'fixed', channel: 'email', ...over })
  const fixedSigner: SendSignDocumentStepConfig['recipients'][number] = { role_key: 'merchant', source: 'fixed', channel: 'email', full_name: 'Dato Aziz', email: 'aziz@kedai.my' }

  it('saves them after the signers, apart from them: no role, no signer row, no link', async () => {
    const out = await runSendSignDocument(
      input({
        cfg: cfg({
          recipients: [
            { role_key: 'merchant', source: 'contact', channel: 'email' },
            copy({ full_name: 'Accounts of {{ contact.company }}', email: ' accounts@kedai.my ' }),
            copy({ full_name: 'Legal', email: 'legal@kedai.my' }),
          ],
        }),
      }),
    )
    // the signers are the one signer: the copies are not mixed in
    expect(m.setSigners).toHaveBeenCalledTimes(1)
    expect(m.setSigners.mock.calls[0][2]).toEqual([expect.objectContaining({ roleKey: 'merchant', email: 'casey@example.com', orderNo: 1 })])
    // ...and the copies are saved on the same document, with a name and an address only
    expect(m.setCopyRecipients).toHaveBeenCalledTimes(1)
    expect(m.setCopyRecipients).toHaveBeenCalledWith(ctx, { documentId: 'doc-1' }, [
      { fullName: 'Accounts of Kedai Casey', email: 'accounts@kedai.my' },
      { fullName: 'Legal', email: 'legal@kedai.my' },
    ])
    // the order: signers first, copies second, then the send
    expect(m.setSigners.mock.invocationCallOrder[0]).toBeLessThan(m.setCopyRecipients.mock.invocationCallOrder[0])
    expect(m.setCopyRecipients.mock.invocationCallOrder[0]).toBeLessThan(m.sendDocument.mock.invocationCallOrder[0])
    expect(out.step).toMatchObject({ status: 'success', outcome: 'sent' })
    expect(out.step.detail).toContain('2 people will also get the signed copy')
  })

  it('the contact can be the one who receives a copy, with their own name and email', async () => {
    const out = await runSendSignDocument(input({ cfg: cfg({ recipients: [fixedSigner, copy({ source: 'contact' })] }) }))
    expect(m.setSigners.mock.calls[0][2]).toEqual([expect.objectContaining({ email: 'aziz@kedai.my' })])
    expect(m.setCopyRecipients).toHaveBeenCalledWith(ctx, { documentId: 'doc-1' }, [{ fullName: 'Casey Lee', email: 'casey@example.com' }])
    expect(out.step.detail).toContain('1 person will also get the signed copy')
  })

  it('a document with no copies does not touch the copy service, and says nothing of copies', async () => {
    const out = await runSendSignDocument(input())
    expect(m.setCopyRecipients).not.toHaveBeenCalled()
    expect(out.step.detail).not.toContain('signed copy')
  })

  it('a draft (send off) says how many will get the copy', async () => {
    const out = await runSendSignDocument(input({ cfg: cfg({ send: false, recipients: [fixedSigner, copy({ full_name: 'Legal', email: 'legal@kedai.my' })] }) }))
    expect(m.sendDocument).not.toHaveBeenCalled()
    expect(out.step).toMatchObject({ status: 'success', outcome: 'draft' })
    expect(out.step.detail).toContain('1 person will also get the signed copy')
  })

  it('a contact with no email who is to receive a copy skips the step before anything is made', async () => {
    const out = await runSendSignDocument(input({ cfg: cfg({ recipients: [fixedSigner, copy({ source: 'contact' })] }), contact: { name: 'Casey', email: '' } }))
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'recipient_email_missing' })
    expect(out.step.detail).toContain('no email')
    expect(m.createDraftFromTemplate).not.toHaveBeenCalled()
    expect(m.setCopyRecipients).not.toHaveBeenCalled()
  })

  it('a run with no contact cannot send a copy to the contact', async () => {
    const out = await runSendSignDocument(input({ contactId: null, contact: null, cfg: cfg({ recipients: [fixedSigner, copy({ source: 'contact' })] }) }))
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'no_contact' })
    expect(m.createDraftFromTemplate).not.toHaveBeenCalled()
  })

  it('the same address as a signer, or twice, is said before anything is made (a {{variable}} may turn out equal)', async () => {
    const same = await runSendSignDocument(input({ cfg: cfg({ recipients: [fixedSigner, copy({ full_name: 'Aziz', email: 'AZIZ@kedai.my' })] }) }))
    expect(same.step).toMatchObject({ status: 'skipped', outcome: 'copy_is_signer' })
    const twice = await runSendSignDocument(input({ cfg: cfg({ recipients: [fixedSigner, copy({ full_name: 'A', email: 'x@kedai.my' }), copy({ full_name: 'B', email: 'X@kedai.my' })] }) }))
    expect(twice.step).toMatchObject({ status: 'skipped', outcome: 'copy_duplicate' })
    // the contact signs and also is named as a copy
    const contact = await runSendSignDocument(input({ cfg: cfg({ recipients: [{ role_key: 'merchant', source: 'contact', channel: 'email' }, copy({ source: 'contact' })] }) }))
    expect(contact.step).toMatchObject({ status: 'skipped', outcome: 'copy_is_signer' })
    expect(m.createDraftFromTemplate).not.toHaveBeenCalled()
  })

  it('a copy the service refuses removes the draft again, like an unusable signer, and is skipped in words', async () => {
    m.setCopyRecipients.mockRejectedValue(new SignError('copy_email', 'Enter a valid email for the person who receives a copy.', 400))
    const out = await runSendSignDocument(input({ cfg: cfg({ recipients: [fixedSigner, copy({ full_name: 'Legal', email: '{{ contact.nope }}' })] }) }))
    expect(out.step).toMatchObject({ status: 'skipped', outcome: 'copy_email' })
    expect(m.deleteDraft).toHaveBeenCalledWith(ctx, 'doc-1')
    expect(m.sendDocument).not.toHaveBeenCalled()
  })

  it('a retry that finds the draft does not save the copies a second time', async () => {
    db.seed('sign_documents', [draft()])
    const out = await runSendSignDocument(
      input({ vars: { sign_document_id: 'doc-1', _sign_doc_key: docKey(CONTACT, TEMPLATE) }, cfg: cfg({ recipients: [fixedSigner, copy({ full_name: 'Legal', email: 'legal@kedai.my' })] }) }),
    )
    expect(m.createDraftFromTemplate).not.toHaveBeenCalled()
    expect(m.setSigners).not.toHaveBeenCalled()
    expect(m.setCopyRecipients).not.toHaveBeenCalled()
    expect(out.step.outcome).toBe('sent')
  })

  it('a step with people who receive a copy but nobody who signs is a configuration error', async () => {
    await expect(runSendSignDocument(input({ cfg: cfg({ recipients: [copy({ full_name: 'Legal', email: 'legal@kedai.my' })] }) }))).rejects.toThrow('who signs')
  })
})
