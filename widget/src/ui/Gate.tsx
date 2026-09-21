import { useState } from 'preact/hooks'

import type { Claim, EnquiryInput, EnquiryRole } from '../api'
import type { Translate } from '../i18n'
import { isPlausibleEmail, isPlausiblePhone, normalizePhone } from '../util'

/** First screen for a brand-new browser: existing user, enquiry, or just chat. */
export function ChoiceScreen({
  t,
  busy,
  onExisting,
  onEnquiry,
  onGuest,
}: {
  t: Translate
  busy: boolean
  onExisting: () => void
  onEnquiry: () => void
  onGuest: () => void
}) {
  return (
    <div class="wcw-screen">
      <h2 class="wcw-screen-title">{t('choiceTitle')}</h2>
      <button type="button" class="wcw-choice" disabled={busy} onClick={onExisting}>
        <span class="wcw-choice-title">{t('choiceExisting')}</span>
        <span class="wcw-choice-hint">{t('choiceExistingHint')}</span>
      </button>
      <button type="button" class="wcw-choice" disabled={busy} onClick={onEnquiry}>
        <span class="wcw-choice-title">{t('choiceEnquiry')}</span>
        <span class="wcw-choice-hint">{t('choiceEnquiryHint')}</span>
      </button>
      <button type="button" class="wcw-linkbtn" disabled={busy} onClick={onGuest}>
        {busy ? t('starting') : t('choiceGuest')}
      </button>
    </div>
  )
}

/** "I'm an existing user": phone and/or email, optional name. */
export function ClaimForm({
  t,
  busy,
  error,
  onSubmit,
}: {
  t: Translate
  busy: boolean
  error: string | null
  onSubmit: (claim: Claim) => void
}) {
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const submit = (e: Event) => {
    e.preventDefault()
    if (busy) return
    const p = phone.trim()
    const em = email.trim()
    if (!p && !em) return setProblem(t('errContact'))
    if (p && !isPlausiblePhone(p)) return setProblem(t('errPhone'))
    if (em && !isPlausibleEmail(em)) return setProblem(t('errEmail'))
    setProblem(null)
    onSubmit({
      phone: p ? normalizePhone(p) : undefined,
      email: em || undefined,
      name: name.trim() || undefined,
    })
  }

  return (
    <form class="wcw-screen" onSubmit={submit} noValidate>
      <h2 class="wcw-screen-title">{t('claimTitle')}</h2>
      <p class="wcw-screen-hint">{t('claimHint')}</p>
      <label class="wcw-field">
        <span>{t('fieldPhone')}</span>
        <input
          type="tel"
          inputMode="tel"
          autocomplete="tel"
          placeholder={t('fieldPhonePh')}
          value={phone}
          disabled={busy}
          onInput={(e) => setPhone((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="wcw-field">
        <span>{t('fieldEmail')}</span>
        <input
          type="email"
          inputMode="email"
          autocomplete="email"
          placeholder={t('fieldEmailPh')}
          value={email}
          disabled={busy}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="wcw-field">
        <span>{t('fieldNameOptional')}</span>
        <input
          type="text"
          autocomplete="name"
          value={name}
          maxLength={120}
          disabled={busy}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>
      <p class="wcw-field-note">{t('contactEither')}</p>
      {(problem || error) && (
        <p class="wcw-form-error" role="alert">
          {problem ?? error}
        </p>
      )}
      <button type="submit" class="wcw-primary" disabled={busy}>
        {busy ? t('starting') : t('claimSubmit')}
      </button>
    </form>
  )
}

const ROLES: Array<{ value: EnquiryRole; key: 'roleParent' | 'roleSchool' | 'roleMerchant' | 'roleOther' }> = [
  { value: 'parent', key: 'roleParent' },
  { value: 'school', key: 'roleSchool' },
  { value: 'merchant', key: 'roleMerchant' },
  { value: 'other', key: 'roleOther' },
]

/** "I have an enquiry": name, phone or email, role, message, consent. */
export function EnquiryForm({
  t,
  busy,
  error,
  onSubmit,
}: {
  t: Translate
  busy: boolean
  error: string | null
  onSubmit: (input: Omit<EnquiryInput, 'locale'>) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<EnquiryRole>('parent')
  const [message, setMessage] = useState('')
  const [consent, setConsent] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const submit = (e: Event) => {
    e.preventDefault()
    if (busy) return
    const n = name.trim()
    const p = phone.trim()
    const em = email.trim()
    const msg = message.trim()
    if (!n) return setProblem(t('errName'))
    if (!p && !em) return setProblem(t('errContact'))
    if (p && !isPlausiblePhone(p)) return setProblem(t('errPhone'))
    if (em && !isPlausibleEmail(em)) return setProblem(t('errEmail'))
    if (!msg || msg.length > 2000) return setProblem(t('errMessage'))
    if (!consent) return setProblem(t('errConsent'))
    setProblem(null)
    onSubmit({
      name: n,
      phone: p ? normalizePhone(p) : undefined,
      email: em || undefined,
      role,
      message: msg,
      consent: true,
    })
  }

  return (
    <form class="wcw-screen" onSubmit={submit} noValidate>
      <h2 class="wcw-screen-title">{t('enquiryTitle')}</h2>
      <label class="wcw-field">
        <span>{t('fieldName')}</span>
        <input
          type="text"
          autocomplete="name"
          value={name}
          maxLength={120}
          disabled={busy}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="wcw-field">
        <span>{t('fieldPhone')}</span>
        <input
          type="tel"
          inputMode="tel"
          autocomplete="tel"
          placeholder={t('fieldPhonePh')}
          value={phone}
          disabled={busy}
          onInput={(e) => setPhone((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="wcw-field">
        <span>{t('fieldEmail')}</span>
        <input
          type="email"
          inputMode="email"
          autocomplete="email"
          placeholder={t('fieldEmailPh')}
          value={email}
          disabled={busy}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
        />
      </label>
      <p class="wcw-field-note">{t('contactEither')}</p>
      <fieldset class="wcw-field wcw-roles">
        <legend>{t('fieldRole')}</legend>
        <div class="wcw-role-row">
          {ROLES.map((r) => (
            <label key={r.value} class={`wcw-chip${role === r.value ? ' wcw-on' : ''}`}>
              <input
                type="radio"
                name="wcw-role"
                value={r.value}
                checked={role === r.value}
                disabled={busy}
                onChange={() => setRole(r.value)}
              />
              {t(r.key)}
            </label>
          ))}
        </div>
      </fieldset>
      <label class="wcw-field">
        <span>{t('fieldMessage')}</span>
        <textarea
          rows={4}
          maxLength={2000}
          placeholder={t('fieldMessagePh')}
          value={message}
          disabled={busy}
          onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)}
        />
      </label>
      <label class="wcw-consent">
        <input
          type="checkbox"
          checked={consent}
          disabled={busy}
          onChange={(e) => setConsent((e.target as HTMLInputElement).checked)}
        />
        <span>{t('consent')}</span>
      </label>
      {(problem || error) && (
        <p class="wcw-form-error" role="alert">
          {problem ?? error}
        </p>
      )}
      <button type="submit" class="wcw-primary" disabled={busy}>
        {busy ? t('starting') : t('submitEnquiry')}
      </button>
    </form>
  )
}
