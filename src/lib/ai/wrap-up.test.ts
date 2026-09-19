import { describe, it, expect } from 'vitest'
import {
  buildClosingNotePrompt,
  buildSummaryPrompt,
  cleanSummary,
  CLOSING_NOTE_MAX_CHARS,
  parseClosingNote,
} from './wrap-up'

const LABELS = [
  { id: 'l1', name: 'Billing' },
  { id: 'l2', name: 'Refund request' },
]

describe('buildClosingNotePrompt', () => {
  it('lists the labels as JSON and asks for the exact name', () => {
    const p = buildClosingNotePrompt({ labels: LABELS, language: 'English' })
    expect(p).toContain('["Billing","Refund request"]')
    expect(p).toContain('English')
    expect(p).toContain('"label"')
  })
  it('says there is nothing to choose when the account has no labels', () => {
    expect(buildClosingNotePrompt({ labels: [], language: 'English' })).toContain('"label" must be null')
  })
  it('treats the conversation as untrusted', () => {
    expect(buildClosingNotePrompt({ labels: [], language: 'English' })).toContain('untrusted')
    expect(buildSummaryPrompt({ language: 'English' })).toContain('untrusted')
  })
  it('asks for a summary in the requested language', () => {
    expect(buildSummaryPrompt({ language: 'Korean' })).toContain('Korean')
  })
})

describe('parseClosingNote', () => {
  it('reads a clean JSON answer and matches the label', () => {
    expect(parseClosingNote('{"note":"Refunded the duplicate charge.","label":"Refund request"}', LABELS)).toEqual({
      note: 'Refunded the duplicate charge.',
      label: LABELS[1],
    })
  })

  it('matches the label case-insensitively but returns the stored one', () => {
    expect(parseClosingNote('{"note":"n","label":"billing"}', LABELS)?.label).toEqual(LABELS[0])
  })

  it('drops a label the model made up', () => {
    expect(parseClosingNote('{"note":"n","label":"Shipping delay"}', LABELS)?.label).toBeNull()
  })

  it('accepts null and a missing label', () => {
    expect(parseClosingNote('{"note":"n","label":null}', LABELS)?.label).toBeNull()
    expect(parseClosingNote('{"note":"n"}', LABELS)?.label).toBeNull()
  })

  it('unwraps a fenced answer with chatter around it', () => {
    const out = 'Sure!\n```json\n{"note":"Sent the invoice.","label":"Billing"}\n```\nHope that helps.'
    expect(parseClosingNote(out, LABELS)).toEqual({ note: 'Sent the invoice.', label: LABELS[0] })
  })

  it('falls back to the plain text as the note when the model ignored the format', () => {
    expect(parseClosingNote('Customer asked about pricing; sent the plan sheet.', LABELS)).toEqual({
      note: 'Customer asked about pricing; sent the plan sheet.',
      label: null,
    })
  })

  it('caps a runaway note', () => {
    const r = parseClosingNote(JSON.stringify({ note: 'x'.repeat(5000), label: null }), LABELS)
    expect(r?.note).toHaveLength(CLOSING_NOTE_MAX_CHARS)
  })

  it.each(['', '   ', '{"note":"","label":"Billing"}', '{"label":"Billing"}'])('returns null for %j', (text) => {
    expect(parseClosingNote(text, LABELS)).toBeNull()
  })
})

describe('cleanSummary', () => {
  it('trims and caps', () => {
    expect(cleanSummary('  - a\n- b  ')).toBe('- a\n- b')
    expect(cleanSummary('x'.repeat(5000))).toHaveLength(1500)
    expect(cleanSummary('  ')).toBeNull()
  })
})
