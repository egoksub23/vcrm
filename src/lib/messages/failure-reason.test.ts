import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  explainFailure,
  failureFromError,
  failureSummary,
  FAILURE_CODE_KIND,
  FAILURE_TEXT,
  UNKNOWN_FAILURE_ACTION,
  UNKNOWN_FAILURE_TITLE,
  type FailureKind,
} from './failure-reason'

describe('explainFailure — the code table', () => {
  it('131030: number not on the test number allowed list', () => {
    const r = explainFailure({ code: 131030, title: 'Recipient phone number not in allowed list' })
    expect(r.kind).toBe('allowlist')
    expect(r.title).toBe("This number is not on your WhatsApp test number's allowed list.")
    expect(r.action).toBe('Add it in Meta, or use a production number.')
    expect(r.retryable).toBe(false)
  })

  it.each([131047, 470])('%i: the 24-hour window has closed, send a template', (code) => {
    const r = explainFailure({ code, channel: 'whatsapp' })
    expect(r.kind).toBe('window_closed')
    expect(r.title).toBe('The 24-hour window has closed.')
    expect(r.action).toMatch(/template/i)
    expect(r.needsTemplate).toBe(true)
  })

  it('a closed window on Messenger / Instagram does not offer a template', () => {
    for (const channel of ['messenger', 'instagram']) {
      const r = explainFailure({ code: 131047, channel })
      expect(r.kind).toBe('window_closed_social')
      expect(r.needsTemplate).toBe(false)
      expect(r.action).not.toMatch(/template/i)
    }
  })

  it('131026 is an undeliverable message, not a closed window', () => {
    const r = explainFailure({ code: 131026 })
    expect(r.kind).toBe('undeliverable')
    expect(r.needsTemplate).toBe(false)
  })

  it.each([190, 463, 467, 102, 401])('%i: the connection has expired, ask an admin to reconnect', (code) => {
    const r = explainFailure({ code })
    expect(r.kind).toBe('auth')
    expect(r.title).toBe('The connection has expired.')
    expect(r.action).toMatch(/admin/i)
  })

  it.each([131056, 130429, 131048, 80007, 613, 4, 17, 32])('%i: sending too fast, wait and retry', (code) => {
    const r = explainFailure({ code })
    expect(r.kind).toBe('rate_limit')
    expect(r.title).toBe('Sending too fast.')
    expect(r.retryable).toBe(true)
  })

  it.each([131005, 200, 3])('%i: a missing permission', (code) => {
    expect(explainFailure({ code }).kind).toBe('permission')
  })

  it('131021: recipient same as sender', () => {
    expect(explainFailure({ code: 131021 }).kind).toBe('same_number')
  })

  it.each([131000, 131016, 133004, 1, 2])('%i: a temporary provider problem is retryable', (code) => {
    const r = explainFailure({ code })
    expect(r.kind).toBe('temporary')
    expect(r.retryable).toBe(true)
  })

  it('maps the marketing cap, template, media, account and Messenger reach codes', () => {
    expect(explainFailure({ code: 131049 }).kind).toBe('marketing_limit')
    expect(explainFailure({ code: 132001 }).kind).toBe('template')
    expect(explainFailure({ code: 131052 }).kind).toBe('media')
    expect(explainFailure({ code: 131042 }).kind).toBe('account_restricted')
    expect(explainFailure({ code: 551, channel: 'messenger' }).kind).toBe('recipient_unavailable')
  })

  it('every code in the table resolves to a kind that has text', () => {
    for (const [code, kind] of Object.entries(FAILURE_CODE_KIND)) {
      expect(FAILURE_TEXT[kind], `code ${code}`).toBeDefined()
      expect(explainFailure({ code: Number(code) }).kind).toBe(kind)
    }
  })
})

describe('explainFailure — wording hints and unknown codes', () => {
  it('reads the wording when the code is a catch-all (10 is permission OR outside the window)', () => {
    expect(
      explainFailure({
        code: 10,
        title: 'This message is sent outside of allowed window.',
        channel: 'messenger',
      }).kind,
    ).toBe('window_closed_social')
    expect(explainFailure({ code: 10, title: 'Permission denied' }).kind).toBe('permission')
    expect(
      explainFailure({ code: 100, details: 'Recipient phone number not in allowed list' }).kind,
    ).toBe('allowlist')
  })

  it('uses the wording when there is no code at all', () => {
    expect(explainFailure({ title: 'Session has expired on Tuesday' }).kind).toBe('auth')
    expect(explainFailure({ title: 'Rate limit hit' }).kind).toBe('rate_limit')
  })

  it("a strong code wins over misleading wording", () => {
    expect(explainFailure({ code: 131030, title: 'rate limit' }).kind).toBe('allowlist')
  })

  it('an unknown code shows Meta\'s own title and the code', () => {
    const r = explainFailure({ code: 999123, title: '(#999123) Something odd happened' })
    expect(r.kind).toBe('unknown')
    expect(r.title).toBe('Something odd happened (code 999123)')
    expect(r.action).toBe(UNKNOWN_FAILURE_ACTION)
    expect(r.rawTitle).toBe('Something odd happened')
    expect(r.code).toBe(999123)
    expect(r.retryable).toBe(true)
  })

  it('nothing at all still gives a readable line', () => {
    const r = explainFailure({})
    expect(r.kind).toBe('unknown')
    expect(r.title).toBe(UNKNOWN_FAILURE_TITLE)
    expect(failureSummary(r)).toContain(UNKNOWN_FAILURE_ACTION)
  })

  it('keeps the raw fields for the details popover', () => {
    const r = explainFailure({ code: 131030, title: 'T', details: ' D ' })
    expect(r).toMatchObject({ code: 131030, rawTitle: 'T', rawDetails: 'D' })
  })
})

describe('failureFromError — what gets stored', () => {
  it("reads a Meta error's code, message and details, without the (#code) prefix", () => {
    const err = Object.assign(new Error('(#131030) Recipient phone number not in allowed list'), {
      code: 131030,
      httpStatus: 400,
      details: 'Add the number to the list',
    })
    expect(failureFromError(err)).toEqual({
      code: 131030,
      title: 'Recipient phone number not in allowed list',
      details: 'Add the number to the list',
    })
  })

  it('stores an email auth failure as 401 so it maps to "reconnect"', () => {
    const err = Object.assign(new Error('Token expired'), { isAuthError: true, httpStatus: 401 })
    const stored = failureFromError(err)
    expect(stored).toEqual({ code: 401, title: 'Token expired', details: null })
    expect(explainFailure(stored).kind).toBe('auth')
  })

  it('handles a plain error and a non-error throw', () => {
    expect(failureFromError(new Error('fetch failed'))).toEqual({
      code: null,
      title: 'fetch failed',
      details: null,
    })
    expect(failureFromError('boom').title).toBe('boom')
  })

  it('clips very long provider text', () => {
    const stored = failureFromError(Object.assign(new Error('x'.repeat(2000)), { details: 'y'.repeat(5000) }))
    expect(stored.title.length).toBeLessThanOrEqual(300)
    expect(stored.details!.length).toBeLessThanOrEqual(1000)
  })
})

describe('the English and Korean catalogues follow the table', () => {
  const load = (locale: string) =>
    JSON.parse(readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8')).Inbox.failure

  const kinds = Object.keys(FAILURE_TEXT) as Exclude<FailureKind, 'unknown'>[]

  it('en.json carries exactly the mapper text for every kind', () => {
    const en = load('en')
    for (const kind of kinds) {
      expect(en.kinds[kind], kind).toEqual(FAILURE_TEXT[kind])
    }
    expect(en.kinds.unknown).toEqual({ title: UNKNOWN_FAILURE_TITLE, action: UNKNOWN_FAILURE_ACTION })
  })

  it('ko.json has a translation for every kind', () => {
    const ko = load('ko')
    for (const kind of [...kinds, 'unknown']) {
      expect(ko.kinds[kind]?.title, kind).toBeTruthy()
      expect(ko.kinds[kind]?.action, kind).toBeTruthy()
    }
  })
})
