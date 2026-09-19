import { matchesWholeWord } from '@/lib/automations/keyword-match'

/**
 * Pure (client-safe) half of auto-labelling: keyword matching and the AI
 * classifier's prompt / output parsing. Split from auto-label.ts, which
 * pulls in server-only modules, so the Settings "test a message" box can
 * run the exact same matcher in the browser.
 */

export interface AutoLabelRule {
  id: string
  tag_id: string
  keywords: string[]
  match_type: 'word' | 'contains'
  description: string | null
  /** Joined from `tags` — the label's name, for the AI prompt. */
  tag_name?: string | null
}

/** Don't spend an AI call on "ok" / "thanks" / "hi". */
export const AI_MIN_TEXT_LENGTH = 12
/** Enough context to classify a topic; caps prompt size and spend. */
export const AI_MAX_TEXT_LENGTH = 1500

function ruleMatches(rule: AutoLabelRule, text: string): boolean {
  if (rule.keywords.length === 0) return false
  const lower = text.toLowerCase()
  return rule.keywords.some((raw) => {
    const keyword = raw.trim()
    if (!keyword) return false
    return rule.match_type === 'contains'
      ? lower.includes(keyword.toLowerCase())
      : matchesWholeWord(text, keyword, false)
  })
}

/** Distinct label ids of every keyword rule the text triggers. Pure — also
 *  drives the "test a message" box in Settings. */
export function matchAutoLabelRules(rules: AutoLabelRule[], text: string): string[] {
  if (!text.trim()) return []
  const tagIds: string[] = []
  for (const rule of rules) {
    if (ruleMatches(rule, text) && !tagIds.includes(rule.tag_id)) tagIds.push(rule.tag_id)
  }
  return tagIds
}

export interface ClassifierCandidate {
  tagId: string
  name: string
  description: string
}

export function classifierCandidates(rules: AutoLabelRule[]): ClassifierCandidate[] {
  const byTag = new Map<string, ClassifierCandidate>()
  for (const r of rules) {
    const description = r.description?.trim()
    if (!description || !r.tag_name || byTag.has(r.tag_id)) continue
    byTag.set(r.tag_id, { tagId: r.tag_id, name: r.tag_name, description })
  }
  return [...byTag.values()]
}

export function buildClassifierPrompt(candidates: ClassifierCandidate[]): string {
  const list = candidates.map((c) => `- ${c.name}: ${c.description}`).join('\n')
  return [
    "You classify a customer's message into at most one support topic.",
    'Topics:',
    list,
    'Reply with ONLY the exact topic name from the list, or NONE if the message',
    "doesn't clearly fit one. No explanation, no punctuation, no quotes.",
  ].join('\n')
}

/** The candidate the model named, or null for NONE / anything unrecognised
 *  (a hallucinated label must never be applied). */
export function parseClassifierOutput(
  output: string,
  candidates: ClassifierCandidate[],
): string | null {
  const cleaned = output
    .trim()
    .replace(/^["'`]+|["'`.]+$/g, '')
    .trim()
    .toLowerCase()
  if (!cleaned || cleaned === 'none') return null
  return candidates.find((c) => c.name.toLowerCase() === cleaned)?.tagId ?? null
}
