import type { SupabaseClient } from '@supabase/supabase-js'
import { stepsUseAi, type ActivationOptions } from '../validate'
import { checkAiAvailability } from './caller'

/**
 * The AI part of the activation check, for the create and update routes.
 * Looks up whether AI can run for the account, but only when the automation
 * has an AI step (an automation without one never touches AI settings).
 * Returns undefined when there is nothing to check.
 */
export async function aiSetupForActivation(
  db: SupabaseClient,
  accountId: string,
  steps: Parameters<typeof stepsUseAi>[0],
): Promise<ActivationOptions['aiSetup'] | undefined> {
  if (!stepsUseAi(steps)) return undefined
  const a = await checkAiAvailability(db, accountId)
  return a.ok ? { ok: true } : { ok: false, message: a.message }
}
