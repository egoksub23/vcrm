import { describe, expect, it } from 'vitest'

import { buildSystemPrompt } from './defaults'

describe('buildSystemPrompt preferred language', () => {
  it('adds the preferred language, by name, and says it overrides matching', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'draft', preferredLanguage: 'ms' })
    expect(p).toContain('preferred conversation language is Malay')
    expect(p).toContain('overrides')
  })

  it('leaves the prompt alone when no language is set', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'draft', preferredLanguage: null })
    expect(p).not.toContain('preferred conversation language')
  })

  it('still works in auto-reply mode', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply', preferredLanguage: 'zh' })
    expect(p).toContain('preferred conversation language is Chinese')
    expect(p).toContain('[[HANDOFF]]')
  })
})

describe('buildSystemPrompt knowledge excerpts', () => {
  const args = { userPrompt: null, knowledge: ['Refunds\n\nWithin 14 days.', 'Hours\n\nNine to six.'] }

  it('numbers the excerpts and asks the model to cite them in square brackets', () => {
    const p = buildSystemPrompt({ ...args, mode: 'draft' })
    expect(p).toContain('[1] Refunds')
    expect(p).toContain('[2] Hours')
    expect(p).toContain('put that excerpt\'s number in square brackets')
    expect(p).toContain('removed before the customer sees your reply')
  })

  it('tells the model files are attached automatically and not to paste links', () => {
    for (const mode of ['draft', 'auto_reply'] as const) {
      const p = buildSystemPrompt({ ...args, mode })
      expect(p).toContain('sent to the customer automatically right after your reply')
      expect(p).toContain('do not paste links or URLs to files')
      expect(p).toContain('never say you cannot send files')
    }
  })

  it('leaves the citation and file instructions out when there are no excerpts', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'draft', knowledge: [] })
    expect(p).not.toContain('square brackets')
    expect(p).not.toContain('sent to the customer automatically')
  })
})
