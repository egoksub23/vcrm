import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { createAdminPgDb } from '@/lib/postgres/db'
import { checkAiAvailability } from '@/lib/automations/ai/caller'

/**
 * GET /api/automations/ai-status
 *
 * Whether AI steps can run for this account: set up, switched on, the
 * Automations job on, and the privacy notice confirmed. The builder shows a
 * warning on AI steps (with a link to AI Agents > Setup) when it cannot.
 * Never returns a key or any provider detail. Read-only.
 */
export async function GET() {
  try {
    const { accountId } = await requireCapability('menu.automations')
    const a = await checkAiAvailability(createAdminPgDb(), accountId)
    return NextResponse.json(a.ok ? { available: true } : { available: false, code: a.code })
  } catch (err) {
    return toErrorResponse(err)
  }
}
