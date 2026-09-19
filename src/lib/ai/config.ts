import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig, AiProvider } from './types'
import type { AiTask } from './tasks'

interface AiConfigRow {
  provider: AiProvider
  base_url: string | null
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
  embeddings_base_url: string | null
  embeddings_model: string | null
  monthly_token_budget: number | null
}

const CONFIG_COLUMNS =
  'provider, base_url, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key, embeddings_base_url, embeddings_model, monthly_token_budget'

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean; task?: AiTask } = {},
): Promise<AiConfig | null> {
  const { requireActive = true, task } = opts
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_key) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  const base: AiConfig = {
    provider: row.provider,
    model: row.model,
    apiKey: decrypt(row.api_key),
    baseUrl: row.base_url,
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
    embeddingsBaseUrl: row.embeddings_base_url,
    embeddingsModel: row.embeddings_model,
    connectionId: null,
    monthlyTokenBudget: row.monthly_token_budget ?? null,
  }

  return task ? applyTaskRouting(db, accountId, task, base) : base
}

/**
 * Point `base` at the connection (and model) this job is routed to.
 * Returns null when the job is switched off. With no routing row — or a
 * routed connection that has since been deleted or can't be decrypted —
 * the account's default connection is used, so a routing mistake degrades
 * to the previous behaviour rather than to no AI at all.
 */
async function applyTaskRouting(
  db: SupabaseClient,
  accountId: string,
  task: AiTask,
  base: AiConfig,
): Promise<AiConfig | null> {
  const { data: routing } = await db
    .from('ai_task_routing')
    .select('connection_id, model_override, enabled')
    .eq('account_id', accountId)
    .eq('task', task)
    .maybeSingle()
  if (!routing) return base
  if (routing.enabled === false) return null

  const override = (routing.model_override as string | null)?.trim() || null
  if (!routing.connection_id) return override ? { ...base, model: override } : base

  const { data: conn } = await db
    .from('ai_connections')
    .select('id, provider, base_url, model, api_key')
    .eq('account_id', accountId)
    .eq('id', routing.connection_id)
    .maybeSingle()
  if (!conn?.api_key) {
    console.warn(`[ai config] ${task} is routed to a missing connection for account ${accountId}; using the default.`)
    return override ? { ...base, model: override } : base
  }
  try {
    return {
      ...base,
      provider: conn.provider as AiProvider,
      baseUrl: (conn.base_url as string | null) ?? null,
      model: override ?? (conn.model as string),
      apiKey: decrypt(conn.api_key as string),
      connectionId: conn.id as string,
    }
  } catch {
    console.error(`[ai config] connection ${conn.id} could not be decrypted — check ENCRYPTION_KEY; ${task} uses the default connection.`)
    return override ? { ...base, model: override } : base
  }
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  db: SupabaseClient,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  const { data, error } = await db
    .from('ai_configs')
    .select('embeddings_api_key')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data?.embeddings_api_key) return { key: null, corrupt: false }
  try {
    return { key: decrypt(data.embeddings_api_key), corrupt: false }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { key: null, corrupt: true }
  }
}

/**
 * The embeddings settings the knowledge-base ingest routes need: the
 * decrypted key plus the optional service URL and model. Same failure
 * handling as `loadEmbeddingsKey`.
 */
export async function loadEmbeddingsConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<{
  config: Pick<AiConfig, 'embeddingsApiKey' | 'embeddingsBaseUrl' | 'embeddingsModel'>
  corrupt: boolean
}> {
  const { key, corrupt } = await loadEmbeddingsKey(db, accountId)
  const { data } = await db
    .from('ai_configs')
    .select('embeddings_base_url, embeddings_model')
    .eq('account_id', accountId)
    .maybeSingle()
  return {
    config: {
      embeddingsApiKey: key,
      embeddingsBaseUrl: (data?.embeddings_base_url as string | null) ?? null,
      embeddingsModel: (data?.embeddings_model as string | null) ?? null,
    },
    corrupt,
  }
}
