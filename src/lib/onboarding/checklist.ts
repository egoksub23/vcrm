// ============================================================
// First-run onboarding checklist (migration 155).
//
// Three steps a new customer admin must do to get value (connect a channel,
// invite the team, add contacts) and three optional extras (a quick reply,
// business hours, a knowledge article). Each is done when the thing really
// exists, read from onboarding_status(), so the list is always accurate and
// never ticked by hand. Pure: the database gathers the facts, this decides.
// ============================================================

export const ONBOARDING_STEPS = ['channel', 'team', 'contacts', 'replies', 'hours', 'knowledge'] as const
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]

export interface OnboardingFacts {
  has_channel: boolean
  has_team: boolean
  has_contacts: boolean
  has_replies: boolean
  has_hours: boolean
  has_knowledge: boolean
  dismissed: boolean
}

export interface OnboardingStep {
  id: OnboardingStepId
  done: boolean
  required: boolean
  /** Where to do it. */
  href: string
  /** The capability that page needs; a step the person cannot act on is still shown, without a link. */
  capability: string
}

const STEP_DEFS: Record<OnboardingStepId, { fact: keyof OnboardingFacts; required: boolean; href: string; capability: string }> = {
  channel: { fact: 'has_channel', required: true, href: '/settings?tab=channels', capability: 'channels.manage' },
  team: { fact: 'has_team', required: true, href: '/settings?tab=team', capability: 'members.invite' },
  contacts: { fact: 'has_contacts', required: true, href: '/contacts', capability: 'contacts.edit' },
  replies: { fact: 'has_replies', required: false, href: '/settings?tab=quick-replies', capability: 'snippets.manage' },
  hours: { fact: 'has_hours', required: false, href: '/settings?tab=sla', capability: 'sla.configure' },
  knowledge: { fact: 'has_knowledge', required: false, href: '/knowledge', capability: 'knowledge.draft' },
}

export function computeOnboarding(facts: OnboardingFacts): OnboardingStep[] {
  return ONBOARDING_STEPS.map((id) => {
    const d = STEP_DEFS[id]
    return { id, done: facts[d.fact] === true, required: d.required, href: d.href, capability: d.capability }
  })
}

export interface OnboardingSummary {
  steps: OnboardingStep[]
  requiredDone: number
  requiredTotal: number
  allRequiredDone: boolean
  allDone: boolean
  /** The first required step still missing (else the first optional one), or null. */
  next: OnboardingStepId | null
  /** Show the card: not dismissed, and something is still missing. */
  visible: boolean
}

export function summarizeOnboarding(facts: OnboardingFacts): OnboardingSummary {
  const steps = computeOnboarding(facts)
  const required = steps.filter((s) => s.required)
  const requiredDone = required.filter((s) => s.done).length
  const missing = steps.filter((s) => !s.done)
  const next = missing.find((s) => s.required) ?? missing[0] ?? null
  return {
    steps,
    requiredDone,
    requiredTotal: required.length,
    allRequiredDone: requiredDone === required.length,
    allDone: missing.length === 0,
    next: next?.id ?? null,
    visible: !facts.dismissed && missing.length > 0,
  }
}

/** Read the answer of onboarding_status() tolerantly: anything missing reads as not done and not dismissed. */
export function parseOnboardingFacts(raw: unknown): OnboardingFacts | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const b = (k: string) => r[k] === true
  return {
    has_channel: b('has_channel'),
    has_team: b('has_team'),
    has_contacts: b('has_contacts'),
    has_replies: b('has_replies'),
    has_hours: b('has_hours'),
    has_knowledge: b('has_knowledge'),
    dismissed: b('dismissed'),
  }
}
