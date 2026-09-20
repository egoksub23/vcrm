import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { listModels } from '@/lib/ai/models'
import { validateBaseUrl } from '@/lib/ai/base-url'
import { failureHint, normalizeBaseUrl } from '@/lib/ai/presets'
import { AiError, type AiProvider } from '@/lib/ai/types'

const PROVIDERS: AiProvider[] = ['openai', 'anthropic', 'openai_compatible']

function fail(message: string, code: string, status = 400, hint: string | null = null) {
  return NextResponse.json({ error: message, code, hint }, { status })
}

/**
 * POST /api/ai/test  (admin+)
 *
 * "Test connection": check a candidate provider / base URL / key against
 * the provider WITHOUT saving.
 *
 *  1. Read the model list (`GET {base}/models`). That proves the host is
 *     reachable and the key is accepted, and gives the form real model
 *     names to offer.
 *  2. When a model is given, send one tiny completion and report the
 *     time and tokens it took.
 *
 * When `api_key` is omitted the stored key is used, so an admin can
 * re-test an existing connection — but only against the SAME provider
 * and URL it was saved for. Otherwise an admin (who can't read the key)
 * could aim it at a host they control and capture it.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireCapability('ai.configure')

    const limit = checkRateLimit(`ai-test:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return fail('Invalid request body', 'bad_request')

    const provider = body.provider as AiProvider
    if (!PROVIDERS.includes(provider)) return fail('Unknown provider', 'bad_request')

    let baseUrl: string | null = null
    if (provider === 'openai_compatible') {
      const checked = await validateBaseUrl(body.base_url)
      if (!checked.ok) return fail('That base URL can’t be used.', checked.code)
      baseUrl = checked.url
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    let apiKeyPlain = rawKey
    if (!apiKeyPlain) {
      const { data: existing } = await supabase
        .from('ai_configs')
        .select('api_key, provider, base_url')
        .eq('account_id', accountId)
        .maybeSingle()
      if (!existing?.api_key) return fail('Enter an API key to test.', 'key_required')
      const sameTarget =
        existing.provider === provider &&
        normalizeBaseUrl(existing.base_url ?? '') === normalizeBaseUrl(baseUrl ?? '')
      if (!sameTarget) {
        return fail('Enter the API key again to test a different provider or URL.', 'key_required')
      }
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return fail('Stored API key could not be decrypted — re-enter your key.', 'key_decrypt_failed')
      }
    }

    // Step 1 — models. A key rejection ends the test; a service with no
    // models endpoint just means "no list", not a failed connection.
    let models: string[] | null = null
    try {
      models = await listModels({ provider, apiKey: apiKeyPlain, baseUrl })
    } catch (err) {
      if (err instanceof AiError && err.code !== 'provider_error') {
        return fail(err.message, err.code, err.code === 'invalid_key' ? 400 : 502, failureHint(baseUrl, err.code))
      }
    }

    if (!model) {
      if (models === null) {
        return fail('This service doesn’t list its models — type the model name, then test again.', 'models_unavailable')
      }
      return NextResponse.json({ ok: true, models, tested_model: false })
    }

    // Step 2 — one small completion with the chosen model.
    try {
      const check = await validateAiCredentials({
        provider,
        model,
        apiKey: apiKeyPlain,
        baseUrl,
        systemPrompt: null,
        isActive: true,
        autoReplyEnabled: false,
        autoReplyMaxPerConversation: 3,
        handoffAgentId: null,
        embeddingsApiKey: null,
      })
      return NextResponse.json({
        ok: true,
        models,
        tested_model: true,
        latency_ms: check.latencyMs,
        sample: check.sample,
        usage: check.usage,
      })
    } catch (err) {
      if (err instanceof AiError) {
        return fail(err.message, err.code, err.code === 'invalid_key' ? 400 : 502, failureHint(baseUrl, err.code))
      }
      console.error('[ai/test] unexpected error:', err)
      return fail('Could not reach the AI provider.', 'network_error', 502)
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
