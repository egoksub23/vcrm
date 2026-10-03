import { describe, expect, it } from 'vitest'

import { SETTINGS_SECTIONS } from '@/components/settings/settings-sections'
import { computeOnboarding, ONBOARDING_STEPS, parseOnboardingFacts, summarizeOnboarding, type OnboardingFacts } from './checklist'

const none: OnboardingFacts = {
  has_channel: false,
  has_team: false,
  has_contacts: false,
  has_replies: false,
  has_hours: false,
  has_knowledge: false,
  dismissed: false,
}

describe('computeOnboarding', () => {
  it('lists the six steps in order, three required and three optional', () => {
    const steps = computeOnboarding(none)
    expect(steps.map((s) => s.id)).toEqual([...ONBOARDING_STEPS])
    expect(steps.filter((s) => s.required).map((s) => s.id)).toEqual(['channel', 'team', 'contacts'])
    expect(steps.every((s) => !s.done)).toBe(true)
  })

  it('marks a step done exactly when its fact is true', () => {
    const steps = computeOnboarding({ ...none, has_team: true, has_hours: true })
    expect(steps.filter((s) => s.done).map((s) => s.id)).toEqual(['team', 'hours'])
  })

  it('points each step at a page that exists in the app', () => {
    for (const s of computeOnboarding(none)) {
      expect(s.href).toMatch(/^\/(settings\?tab=[a-z-]+|contacts|knowledge)$/)
      const tab = s.href.split('tab=')[1]
      if (tab) expect(SETTINGS_SECTIONS as readonly string[]).toContain(tab)
    }
  })
})

describe('summarizeOnboarding', () => {
  it('a new workspace: nothing done, the first required step is next, the card shows', () => {
    const s = summarizeOnboarding(none)
    expect(s).toMatchObject({ requiredDone: 0, requiredTotal: 3, allRequiredDone: false, allDone: false, next: 'channel', visible: true })
  })

  it('moves "next" along as required steps are done, then on to the optional ones', () => {
    expect(summarizeOnboarding({ ...none, has_channel: true }).next).toBe('team')
    expect(summarizeOnboarding({ ...none, has_channel: true, has_team: true }).next).toBe('contacts')
    const required = summarizeOnboarding({ ...none, has_channel: true, has_team: true, has_contacts: true })
    expect(required).toMatchObject({ allRequiredDone: true, allDone: false, next: 'replies', visible: true })
  })

  it('hides itself when everything is done, and when dismissed', () => {
    const all = { ...none, has_channel: true, has_team: true, has_contacts: true, has_replies: true, has_hours: true, has_knowledge: true }
    expect(summarizeOnboarding(all)).toMatchObject({ allDone: true, next: null, visible: false })
    expect(summarizeOnboarding({ ...none, dismissed: true }).visible).toBe(false)
  })
})

describe('parseOnboardingFacts', () => {
  it('reads the database answer, with anything missing as false', () => {
    expect(parseOnboardingFacts({ has_channel: true, has_team: 'yes', dismissed: true })).toEqual({
      ...none,
      has_channel: true,
      dismissed: true,
    })
  })

  it('is null for something that is not an object', () => {
    expect(parseOnboardingFacts(null)).toBeNull()
    expect(parseOnboardingFacts('nope')).toBeNull()
  })
})
