// ------------------------------------------------------------
// The variables a step can use: what the trigger provides, plus the `vars.*`
// produced by AI steps that come before it. Feeds the "Insert variable"
// dropdown in the builder. Pure and client-safe.
// ------------------------------------------------------------

export interface VarOption {
  /** What goes into the text, e.g. `{{ vars.summary }}`. */
  token: string
  /** Which group the option belongs to in the dropdown. */
  group: 'trigger' | 'contact' | 'step'
  /** Short name shown in the dropdown (`summary`, `sentiment`, `contact.name`). */
  name: string
}

interface TreeStep {
  cid: string
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes: TreeStep[]; no: TreeStep[] }
}

const DEFAULT_KEYS: Record<string, string> = {
  ai_reply: 'ai_reply',
  ai_summarize: 'summary',
  ai_translate: 'translation',
}
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/

/** The var keys one step writes. */
export function varsProducedBy(step: { step_type: string; step_config: Record<string, unknown> }): string[] {
  const c = step.step_config ?? {}
  if (step.step_type === 'ai_extract') {
    const fields = Array.isArray(c.fields) ? (c.fields as { key?: unknown }[]) : []
    return fields.map((f) => (typeof f?.key === 'string' ? f.key : '')).filter((k) => KEY_RE.test(k))
  }
  const fallback = DEFAULT_KEYS[step.step_type]
  if (!fallback) return []
  const k = typeof c.save_to === 'string' ? c.save_to.trim() : ''
  return [KEY_RE.test(k) ? k : fallback]
}

/**
 * The variables available to the step `targetCid`: the trigger's, the
 * contact's, and every AI-produced var from steps that appear before it in the
 * flow (reading the tree top to bottom, yes column before no column).
 */
export function variablesFor(
  steps: TreeStep[],
  targetCid: string,
  opts: { triggerType?: string } = {},
): VarOption[] {
  const out: VarOption[] = [
    { token: '{{ message.text }}', group: 'trigger', name: 'message.text' },
    ...(opts.triggerType === 'conversation_closed'
      ? [{ token: '{{ closure.note }}', group: 'trigger' as const, name: 'closure.note' }]
      : []),
    { token: '{{ contact.name }}', group: 'contact', name: 'contact.name' },
    { token: '{{ contact.first_name }}', group: 'contact', name: 'contact.first_name' },
    { token: '{{ contact.email }}', group: 'contact', name: 'contact.email' },
    { token: '{{ contact.company }}', group: 'contact', name: 'contact.company' },
    { token: '{{ contact.phone }}', group: 'contact', name: 'contact.phone' },
  ]
  const seen = new Set<string>()
  let found = false
  const walk = (list: TreeStep[]) => {
    for (const s of list) {
      if (found) return
      if (s.cid === targetCid) {
        found = true
        return
      }
      for (const key of varsProducedBy(s)) {
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ token: `{{ vars.${key} }}`, group: 'step', name: key })
      }
      if (s.branches) {
        walk(s.branches.yes)
        walk(s.branches.no)
      }
    }
  }
  walk(steps)
  return out
}
