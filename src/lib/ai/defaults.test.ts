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
