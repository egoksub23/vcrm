import type { SupabaseClient } from '@supabase/supabase-js'
import { validateAiCredentials } from './validate'
import { listModels } from './models'
import { AiError, type AiProvider } from './types'
import { AI_TASKS, DEFAULT_ROUTING, type AiTask, type TaskRouting } from './tasks'

// ============================================================
// AI connections: probing one, recording its health, and reading the
// routing table with defaults filled in.
// ============================================================

export const CONNECTION_NAME_MAX = 60

export type ProbeResult =
  | { ok: true; latencyMs: number | null; models: string[] | null }
  | { ok: false; code: string; message: string }

/**
 * Prove a connection works: the model list first (reachable + key
 * accepted; a service without one is fine), then one tiny completion with
 * the chosen model. Never throws.
 */
export async function probeConnection(a: {
  provider: AiProvider
  baseUrl: string | null
  model: string
  apiKey: string
}): Promise<ProbeResult> {
  let models: string[] | null = null
  try {
    models = await listModels({ provider: a.provider, apiKey: a.apiKey, baseUrl: a.baseUrl })
  } catch (err) {
    // A rejected key ends the test; a missing models endpoint does not.
    if (err instanceof AiError && err.code !== 'provider_error') {
      return { ok: false, code: err.code, message: err.message }
    }
  }
  if (!a.model.trim()) {
    return { ok: false, code: 'model_required', message: 'Choose a model to test.' }
  }
  try {
    const check = await validateAiCredentials({
      provider: a.provider,
      model: a.model.trim(),
      apiKey: a.apiKey,
      baseUrl: a.baseUrl,
      systemPrompt: null,
      isActive: true,
      autoReplyEnabled: false,
      autoReplyMaxPerConversation: 3,
      handoffAgentId: null,
      embeddingsApiKey: null,
    })
    return { ok: true, latencyMs: check.latencyMs, models }
  } catch (err) {
    if (err instanceof AiError) return { ok: false, code: err.code, message: err.message }
    return { ok: false, code: 'network_error', message: 'Could not reach the AI provider.' }
  }
}

/** Store the outcome of a test on the connection (null id = the default). */
export async function recordConnectionHealth(
  db: SupabaseClient,
  args: { accountId: string; connectionId: string | null; probe: ProbeResult },
): Promise<void> {
  const update = {
    health_status: args.probe.ok ? 'ok' : 'error',
    health_checked_at: new Date().toISOString(),
    health_error: args.probe.ok ? null : args.probe.message.slice(0, 300),
  }
  const q = args.connectionId
    ? db.from('ai_connections').update(update).eq('id', args.connectionId).eq('account_id', args.accountId)
    : db.from('ai_configs').update(update).eq('account_id', args.accountId)
  const { error } = await q
  if (error) console.error('[ai connections] health update failed:', error)
}

interface RoutingRow {
  task: string
  connection_id: string | null
  model_override: string | null
  enabled: boolean
}

/** Every job's routing, defaults filled in for jobs with no row. */
export function fillRouting(rows: RoutingRow[]): TaskRouting[] {
  const byTask = new Map(rows.map((r) => [r.task, r]))
  return AI_TASKS.map((task: AiTask) => {
    const r = byTask.get(task)
    return r
      ? { task, connectionId: r.connection_id, modelOverride: r.model_override, enabled: r.enabled }
      : { task, ...DEFAULT_ROUTING }
  })
}
