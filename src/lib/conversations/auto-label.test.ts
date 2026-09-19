import { describe, it, expect } from 'vitest'
import {
  buildClassifierPrompt,
  classifierCandidates,
  matchAutoLabelRules,
  parseClassifierOutput,
  type AutoLabelRule,
} from './auto-label'

function rule(over: Partial<AutoLabelRule> & { id: string; tag_id: string }): AutoLabelRule {
  return { keywords: [], match_type: 'word', description: null, tag_name: null, ...over }
}

describe('matchAutoLabelRules', () => {
  const rules = [
    rule({ id: '1', tag_id: 'billing', keywords: ['refund', 'invoice'] }),
    rule({ id: '2', tag_id: 'tech', keywords: ['error', 'crash'] }),
    rule({ id: '3', tag_id: 'billing', keywords: ['charged'] }),
  ]

  it('returns each matching label once, in rule order', () => {
    expect(matchAutoLabelRules(rules, 'I was charged twice, need a refund')).toEqual(['billing'])
    expect(matchAutoLabelRules(rules, 'App crash and I want a refund')).toEqual(['billing', 'tech'])
  })

  it('is case-insensitive and returns nothing for blank or unrelated text', () => {
    expect(matchAutoLabelRules(rules, 'REFUND please')).toEqual(['billing'])
    expect(matchAutoLabelRules(rules, 'hello there')).toEqual([])
    expect(matchAutoLabelRules(rules, '   ')).toEqual([])
  })

  it('whole-word mode does not fire inside a longer word; contains mode does', () => {
    const word = [rule({ id: 'w', tag_id: 't', keywords: ['pay'], match_type: 'word' })]
    const contains = [rule({ id: 'c', tag_id: 't', keywords: ['pay'], match_type: 'contains' })]
    expect(matchAutoLabelRules(word, 'my payment failed')).toEqual([])
    expect(matchAutoLabelRules(word, 'I want to pay')).toEqual(['t'])
    expect(matchAutoLabelRules(contains, 'my payment failed')).toEqual(['t'])
  })

  it('ignores rules that only have a description (those are for the AI pass)', () => {
    expect(matchAutoLabelRules([rule({ id: 'd', tag_id: 't', description: 'money problems' })], 'money')).toEqual([])
  })
})

describe('AI classifier helpers', () => {
  const rules = [
    rule({ id: '1', tag_id: 'billing', description: 'Payments, refunds, invoices', tag_name: 'Billing' }),
    rule({ id: '2', tag_id: 'billing', description: 'duplicate tag', tag_name: 'Billing' }),
    rule({ id: '3', tag_id: 'noname', description: 'x', tag_name: null }),
    rule({ id: '4', tag_id: 'nodesc', keywords: ['a'], tag_name: 'Other' }),
    rule({ id: '5', tag_id: 'tech', description: 'Bugs and outages', tag_name: 'Technical' }),
  ]
  const candidates = classifierCandidates(rules)

  it('builds candidates only from rules with a description and a resolvable label name, one per label', () => {
    expect(candidates.map((c) => c.tagId)).toEqual(['billing', 'tech'])
  })

  it('lists every candidate in the prompt and tells the model to answer NONE when unsure', () => {
    const prompt = buildClassifierPrompt(candidates)
    expect(prompt).toContain('- Billing: Payments, refunds, invoices')
    expect(prompt).toContain('- Technical: Bugs and outages')
    expect(prompt).toContain('NONE')
  })

  it('maps the model output back to a label, tolerating case, quotes and a trailing period', () => {
    expect(parseClassifierOutput('Billing', candidates)).toBe('billing')
    expect(parseClassifierOutput(' "technical". ', candidates)).toBe('tech')
  })

  it('never applies NONE, empty output, or a label the model invented', () => {
    expect(parseClassifierOutput('NONE', candidates)).toBeNull()
    expect(parseClassifierOutput('none.', candidates)).toBeNull()
    expect(parseClassifierOutput('', candidates)).toBeNull()
    expect(parseClassifierOutput('Shipping', candidates)).toBeNull()
  })
})
