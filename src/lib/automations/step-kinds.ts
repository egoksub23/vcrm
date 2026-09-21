// ------------------------------------------------------------
// Which automation steps are AI steps, and which carry branches.
//
// Pure and dependency-free so the builder (client), the validator and the
// step-tree writers can all share it.
// ------------------------------------------------------------

/** Steps that call the AI. `ai_question` (Ask AI yes/no) is a subject of the
 *  Condition step, not a step of its own; see `usesAi`. */
export const AI_STEP_TYPES = ['ai_reply', 'ai_extract', 'ai_summarize', 'ai_translate'] as const
export type AiStepType = (typeof AI_STEP_TYPES)[number]

/** At most this many AI calls run in one automation run (Ask AI included). */
export const MAX_AI_STEPS_PER_RUN = 5

/** Steps with a "yes" and a "no" column of children. For `ai_reply` they are
 *  the "Answered" and "Couldn't answer" outcomes. */
export const BRANCHING_STEP_TYPES = ['condition', 'ai_reply'] as const

export function isAiStepType(t: unknown): t is AiStepType {
  return typeof t === 'string' && (AI_STEP_TYPES as readonly string[]).includes(t)
}

export function hasBranches(stepType: string): boolean {
  return (BRANCHING_STEP_TYPES as readonly string[]).includes(stepType)
}

interface StepLike {
  step_type: string
  step_config?: Record<string, unknown> | null
  branches?: { yes?: StepLike[]; no?: StepLike[] }
}

/** Whether a single step calls the AI: an AI step, Ask AI in a Condition, or
 *  Create ticket with "Let AI write the subject and description". */
export function usesAi(step: StepLike): boolean {
  if (isAiStepType(step.step_type)) return true
  if (step.step_type === 'create_ticket') return step.step_config?.ai_write === true
  return step.step_type === 'condition' && step.step_config?.subject === 'ai_question'
}

/** Every step in the tree, parents before their children. */
export function flattenSteps<T extends StepLike>(steps: T[]): T[] {
  const out: T[] = []
  const walk = (list: T[]) => {
    for (const s of list) {
      out.push(s)
      if (s.branches) {
        walk((s.branches.yes ?? []) as T[])
        walk((s.branches.no ?? []) as T[])
      }
    }
  }
  walk(steps)
  return out
}

/** How many steps in the tree call the AI. */
export function countAiSteps(steps: StepLike[]): number {
  return flattenSteps(steps).filter(usesAi).length
}
