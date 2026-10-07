// ------------------------------------------------------------
// Running the "Send a document for signing" step (engine.ts calls this).
//
// It reuses the Doc Sign services a person's own screens use, so every rule
// holds the same way: the draft comes from the template (createDraftFromTemplate),
// the values and the message go on with updateDraft, the people with setSigners,
// and the send goes through sendDocument (the monthly limit, the readiness
// checks, the audit trail and the invitations). Nothing here bypasses them.
//
// A problem that Doc Sign explains (the limit was reached, the document is not
// ready, a recipient has no valid email) must not break the rest of the run: the
// step reports "skipped" with the reason in words and the run goes on. Only an
// unexpected failure (a bug, the database down) is thrown, like any other step.
// ------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'

import { getSignChainDepth } from './sign-event'
import { copiesOf, signersOf } from './sign-step'
import type { SendSignDocumentStepConfig } from '@/types'
import type { SignCtx } from '@/lib/sign/service/context'
import type { SignDocumentRow } from '@/lib/sign/types'

export interface SendSignDocumentInput {
  cfg: SendSignDocumentStepConfig
  accountId: string
  /** The automation's owner: the person the document is "created by". */
  ownerUserId: string | null
  automation: { id: string; name: string }
  contactId: string | null
  /** The contact's name, email and phone (and company), when the run has one. */
  contact: Record<string, unknown> | null
  /** `context.vars` of the run, read for the retry check and the loop guard. */
  vars: Record<string, unknown>
  /** Fill {{ ... }} in a piece of text (the engine's interpolation). */
  text: (s: string) => string
  /** Test seam: the context to use instead of the real one. */
  ctx?: SignCtx
}

export interface SendSignDocumentResult {
  step: { status: 'success' | 'skipped'; outcome: string; detail: string }
  /** Merged into `context.vars` for the steps that follow. */
  varsPatch: Record<string, unknown>
}

const skip = (detail: string, outcome = 'skipped'): SendSignDocumentResult => ({ step: { status: 'skipped', outcome, detail: `skipped: ${detail}` }, varsPatch: {} })

/** The context of a Doc Sign call made by an automation (no signed-in person, but the owner as author). */
async function automationCtx(accountId: string, userId: string | null, depth: number): Promise<SignCtx | null> {
  const origin = (await import('@/lib/site-url')).publicOrigin()
  if (!origin) return null
  const [{ supabaseAdmin }, { realDeps }] = await Promise.all([import('./admin-client'), import('@/lib/sign/notify')])
  return { admin: supabaseAdmin() as SupabaseClient, accountId, userId, origin, deps: realDeps, now: () => new Date(), chainDepth: depth }
}

/** The step's idempotency key: the same contact and template in one run are one document. */
export const docKey = (contactId: string | null, templateId: string) => `${contactId ?? ''}:${templateId}`

export async function runSendSignDocument(input: SendSignDocumentInput): Promise<SendSignDocumentResult> {
  const { cfg, accountId } = input
  const templateId = typeof cfg.template_id === 'string' ? cfg.template_id.trim() : ''
  if (!templateId) throw new Error('send_sign_document needs a template')
  // Who signs gets a role and a link; who only receives the signed copy is saved apart (never a role, never a signer row).
  const recipients = signersOf(cfg)
  const copyRecipients = copiesOf(cfg)
  if (recipients.length === 0) throw new Error('send_sign_document needs at least one recipient who signs')

  const ctx = input.ctx ?? (await automationCtx(accountId, input.ownerUserId, getSignChainDepth(input.vars)))
  if (!ctx) return skip('the public address of this server is not set (NEXT_PUBLIC_SITE_URL), so signing links cannot be made', 'not_configured')

  const { signEnabled } = await import('@/lib/sign/feature')
  if (!(await signEnabled(ctx.admin, accountId))) return skip('Doc Sign is not turned on for this workspace', 'not_enabled')

  const { SignError } = await import('@/lib/sign/service/errors')
  const drafts = await import('@/lib/sign/service/drafts')
  const { sendDocument } = await import('@/lib/sign/service/send')
  const { loadDocument } = await import('@/lib/sign/service/context')

  const key = docKey(input.contactId, templateId)
  let documentId: string | null = null
  let created = false

  try {
    // A retry of this run (a resumed wait, a repeated pass) finds the document the first pass made.
    const known = typeof input.vars.sign_document_id === 'string' ? input.vars.sign_document_id : null
    if (known && input.vars._sign_doc_key === key) {
      try {
        const existing = await loadDocument(ctx, known)
        if (existing.status !== 'draft') {
          return { step: { status: 'success', outcome: 'already_sent', detail: `document ${existing.reference ?? existing.id} was already made by this run; not sent twice` }, varsPatch: {} }
        }
        documentId = existing.id
      } catch (err) {
        if (!(err instanceof SignError)) throw err
        // the document is gone: make a new one
      }
    }

    // Who signs. The contact's own details come from the contact; a missing one is said in words, before anything is made.
    const people: { role_key: string; full_name: string; email: string; phone: string; channel: 'email' | 'whatsapp' }[] = []
    for (const r of recipients) {
      if (r.source === 'contact') {
        if (!input.contactId || !input.contact) return skip('this run has no contact to send the document to', 'no_contact')
        const name = String(input.contact.name ?? '').trim()
        const email = String(input.contact.email ?? '').trim()
        const phone = String(input.contact.phone ?? '').trim()
        if (!email) return skip('the contact has no email address (Doc Sign needs one for every signer). Add it, or use a fixed recipient', 'recipient_email_missing')
        if (r.channel === 'whatsapp' && !phone) return skip('the contact has no phone number, so the link cannot go by WhatsApp', 'recipient_phone_missing')
        people.push({ role_key: r.role_key, full_name: name || email, email, phone, channel: r.channel })
      } else {
        people.push({
          role_key: r.role_key,
          full_name: input.text(String(r.full_name ?? '')).trim(),
          email: input.text(String(r.email ?? '')).trim(),
          phone: input.text(String(r.phone ?? '')).trim(),
          channel: r.channel,
        })
      }
    }

    // Who receives the signed copy: the same details, from the contact or fixed, with no channel and no phone.
    const copies: { fullName: string; email: string }[] = []
    for (const r of copyRecipients) {
      if (r.source === 'contact') {
        if (!input.contactId || !input.contact) return skip('this run has no contact to send the signed copy to', 'no_contact')
        const name = String(input.contact.name ?? '').trim()
        const email = String(input.contact.email ?? '').trim()
        if (!email) return skip('the contact has no email address (Doc Sign needs one for everyone who receives a copy). Add it, or use a fixed recipient', 'recipient_email_missing')
        copies.push({ fullName: name || email, email })
      } else {
        copies.push({ fullName: input.text(String(r.full_name ?? '')).trim(), email: input.text(String(r.email ?? '')).trim() })
      }
    }
    // The same address twice (a {{variable}} that turned out equal) is said before anything is made.
    const signing = new Set(people.map((p) => p.email.toLowerCase()))
    const receiving = new Set<string>()
    for (const c of copies) {
      const k = c.email.toLowerCase()
      if (!k) continue
      if (signing.has(k)) return skip('a person who receives a copy also signs the document, so they get the signed copy anyway', 'copy_is_signer')
      if (receiving.has(k)) return skip('the same person is set to receive a copy twice', 'copy_duplicate')
      receiving.add(k)
    }

    let doc: SignDocumentRow
    if (documentId) {
      doc = await loadDocument(ctx, documentId)
    } else {
      doc = await drafts.createDraftFromTemplate(ctx, {
        templateId,
        contactId: input.contactId,
        title: cfg.title ? input.text(cfg.title).trim() || undefined : undefined,
      })
      created = true
      documentId = doc.id
    }

    // From here the draft exists and is linked to the contact: say so in the variables whatever happens next.
    const varsPatch: Record<string, unknown> = { sign_document_id: doc.id, sign_reference: doc.reference ?? '', _sign_doc_key: key }

    try {
      if (created) {
        const merge: Record<string, string> = {}
        for (const [k, v] of Object.entries(cfg.merge_values ?? {})) merge[k] = input.text(String(v ?? ''))
        const patch: Parameters<typeof drafts.updateDraft>[2] = {}
        if (Object.keys(merge).length > 0) patch.mergeValues = merge
        const message = cfg.message ? input.text(cfg.message).trim() : ''
        if (message) patch.message = message
        if (cfg.locale) patch.locale = cfg.locale
        if (Object.keys(patch).length > 0) doc = await drafts.updateDraft(ctx, doc.id, patch)

        const kindOf = new Map(doc.roles_snapshot.map((r) => [r.key, r.kind]))
        for (const p of people) {
          if (!kindOf.has(p.role_key)) throw new SignError('signer_role', `The template has no role "${p.role_key}".`, 400)
        }
        await drafts.setSigners(
          ctx,
          doc.id,
          people.map((p, i) => ({ roleKey: p.role_key, kind: kindOf.get(p.role_key)!, fullName: p.full_name, email: p.email, phone: p.phone || null, channel: p.channel, orderNo: i + 1 })),
        )
        // the people who receive the signed copy go on after the signers (the check "they also sign" needs the signers saved)
        if (copies.length > 0) {
          const { setCopyRecipients } = await import('@/lib/sign/service/copy-recipients')
          await setCopyRecipients(ctx, { documentId: doc.id }, copies)
        }
      }
    } catch (err) {
      // An unusable draft (bad values, a role that is not there) is removed so a retry does not pile them up.
      if (created) await drafts.deleteDraft(ctx, doc.id).catch(() => undefined)
      throw err
    }

    // said in the result: how many people will also get the signed copy (only those saved by this pass)
    const copyNote = created && copies.length > 0 ? `; ${copies.length} ${copies.length === 1 ? 'person' : 'people'} will also get the signed copy` : ''

    if (cfg.send === false) {
      return { step: { status: 'success', outcome: 'draft', detail: `draft ${doc.reference ?? doc.id} created for a person to check and send${copyNote}` }, varsPatch }
    }

    try {
      const sent = await sendDocument(ctx, doc.id)
      const unreached = sent.invited.filter((i) => i.delivery.status !== 'sent').length
      return {
        step: {
          status: 'success',
          outcome: 'sent',
          detail: `document ${sent.reference ?? doc.id} sent to ${sent.invited.length} ${sent.invited.length === 1 ? 'person' : 'people'}${unreached ? `; ${unreached} could not be reached, see the document's history` : ''}${copyNote}`,
        },
        varsPatch: { ...varsPatch, sign_reference: sent.reference ?? doc.reference ?? '' },
      }
    } catch (err) {
      if (err instanceof SignError) {
        // The draft stays (complete, linked to the contact) so a person can fix the cause and send it.
        console.warn('[automations] send_sign_document: could not send', { automationId: input.automation.id, code: err.code })
        return { step: { status: 'skipped', outcome: err.code, detail: `skipped: the document was saved as a draft but not sent (${describe(err)})` }, varsPatch }
      }
      throw err
    }
  } catch (err) {
    if (err instanceof SignError) {
      console.warn('[automations] send_sign_document: skipped', { automationId: input.automation.id, code: err.code })
      return skip(describe(err), err.code)
    }
    throw err
  }
}

/** The reason in one line: the message, and the readiness problems when there are some. */
function describe(err: { code: string; message: string; issues?: { code: string; detail?: string; role?: string }[] }): string {
  const issues = (err.issues ?? []).map((i) => [i.code, i.role ?? i.detail].filter(Boolean).join(':'))
  return issues.length > 0 ? `${err.message} [${err.code}: ${issues.slice(0, 6).join(', ')}]` : `${err.message} [${err.code}]`
}
