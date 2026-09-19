import { generateReply } from './generate'
import type { AiConfig, AiUsage } from './types'

export interface CredentialCheck {
  /** What the model said to the connectivity prompt. */
  sample: string
  usage: AiUsage | null
  latencyMs: number
}

/**
 * Cheap liveness + auth check: one tiny generation against the
 * configured provider/model with the caller's key. Throws `AiError`
 * (invalid_key / rate_limited / network / timeout) on failure, resolves
 * with what came back on success. Used by the settings "Test connection"
 * button and before persisting a config — the same "verify before save"
 * discipline the WhatsApp config uses with Meta.
 */
export async function validateAiCredentials(config: AiConfig): Promise<CredentialCheck> {
  const started = Date.now()
  const result = await generateReply({
    config,
    systemPrompt: 'You are a connectivity check. Reply with the single word: OK.',
    messages: [{ role: 'user', content: 'ping' }],
  })
  return { sample: result.text, usage: result.usage, latencyMs: Date.now() - started }
}
