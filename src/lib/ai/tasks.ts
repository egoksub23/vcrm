// ============================================================
// The AI jobs the CRM runs, each of which can be routed to its own
// connection and model (Settings → AI Agents → Connections).
// ============================================================

export const AI_TASKS = ['draft', 'auto_reply', 'auto_label', 'closing_note', 'summary', 'translate', 'automation'] as const
export type AiTask = (typeof AI_TASKS)[number]

export function isAiTask(v: unknown): v is AiTask {
  return typeof v === 'string' && (AI_TASKS as readonly string[]).includes(v)
}

/** A routing row as stored: which connection (null = the default one),
 *  an optional model override, and whether the job is on. */
export interface TaskRouting {
  task: AiTask
  connectionId: string | null
  modelOverride: string | null
  enabled: boolean
}

export const DEFAULT_ROUTING: Omit<TaskRouting, 'task'> = {
  connectionId: null,
  modelOverride: null,
  enabled: true,
}
