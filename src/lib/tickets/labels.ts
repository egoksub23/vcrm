export const MAX_LABELS = 10
export const MAX_LABEL_LENGTH = 30

/** Lower-cased, trimmed, inner whitespace collapsed; commas become spaces
 *  (a comma separates labels in the URL and in the activity log). */
export function normalizeLabel(raw: string): string {
  return raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

export type LabelProblem = 'empty' | 'tooLong' | 'tooMany' | 'duplicate'

export type AddLabelResult =
  | { ok: true; labels: string[]; label: string }
  | { ok: false; problem: LabelProblem }

/** Add one label to a ticket's list, or say why not. */
export function addLabel(labels: string[], raw: string): AddLabelResult {
  const label = normalizeLabel(raw)
  if (!label) return { ok: false, problem: 'empty' }
  if ([...label].length > MAX_LABEL_LENGTH) return { ok: false, problem: 'tooLong' }
  if (labels.includes(label)) return { ok: false, problem: 'duplicate' }
  if (labels.length >= MAX_LABELS) return { ok: false, problem: 'tooMany' }
  return { ok: true, labels: [...labels, label], label }
}

export function removeLabel(labels: string[], label: string): string[] {
  return labels.filter((l) => l !== label)
}

/** Suggestions for the combobox: labels in use in the account that the
 *  ticket does not have yet and that contain what was typed, most used first. */
export function suggestLabels(
  known: { label: string; uses: number }[],
  current: string[],
  query: string,
  limit = 8,
): string[] {
  const q = normalizeLabel(query)
  return known
    .filter((k) => !current.includes(k.label) && (!q || k.label.includes(q)))
    .sort((a, b) => b.uses - a.uses || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map((k) => k.label)
}
