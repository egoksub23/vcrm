import { describe, it, expect } from 'vitest'
import { latestUserMessage, recentCustomerText } from './query'

describe('latestUserMessage', () => {
  it('returns the most recent user turn', () => {
    expect(
      latestUserMessage([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest' },
      ]),
    ).toBe('latest')
  })

  it('falls back to the last message when none are user', () => {
    expect(
      latestUserMessage([{ role: 'assistant', content: 'only assistant' }]),
    ).toBe('only assistant')
  })

  it('returns empty string for no messages', () => {
    expect(latestUserMessage([])).toBe('')
  })
})

describe('recentCustomerText', () => {
  it('joins the last three customer turns, oldest first', () => {
    expect(
      recentCustomerText([
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'three' },
        { role: 'user', content: 'four' },
      ]),
    ).toBe('two\nthree\nfour')
  })

  it('ignores assistant turns', () => {
    expect(
      recentCustomerText([
        { role: 'user', content: 'Pro plan for 5 agents?' },
        { role: 'assistant', content: 'Sure, one moment.' },
        { role: 'user', content: 'and how much yearly?' },
      ]),
    ).toBe('Pro plan for 5 agents?\nand how much yearly?')
  })

  it('stops adding older turns once the budget is spent', () => {
    const long = 'x'.repeat(400)
    expect(recentCustomerText([
      { role: 'user', content: long },
      { role: 'user', content: long },
    ])).toBe(long)
  })

  it('returns an empty string when the customer has said nothing', () => {
    expect(recentCustomerText([{ role: 'assistant', content: 'hi' }])).toBe('')
  })
})
