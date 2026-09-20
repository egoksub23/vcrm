import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { isAiTask } from '@/lib/ai/tasks'

const MODEL_MAX = 100

/**
 * PUT /api/ai/routing  (admin+)
 * Body: { routing: [{ task, connection_id: string | null, model_override: string | null, enabled: boolean }] }
 *
 * Sets, per AI job, which connection serves it (null = the default), an
 * optional model override, and whether it runs at all. Any subset of jobs
 * may be sent.
 */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireCapability('ai.configure')
    const body = (await request.json().catch(() => null)) as { routing?: unknown } | null
    if (!body || !Array.isArray(body.routing) || body.routing.length === 0) {
      return NextResponse.json({ error: 'routing must be a list' }, { status: 400 })
    }

    const { data: owned } = await supabase.from('ai_connections').select('id').eq('account_id', accountId)
    const ownedIds = new Set((owned ?? []).map((c) => c.id as string))

    const rows: Record<string, unknown>[] = []
    for (const item of body.routing as Record<string, unknown>[]) {
      if (!item || !isAiTask(item.task)) return NextResponse.json({ error: 'Unknown AI job' }, { status: 400 })
      const connectionId = item.connection_id === null || item.connection_id === undefined ? null : String(item.connection_id)
      if (connectionId && !ownedIds.has(connectionId)) {
        return NextResponse.json({ error: 'That connection does not exist' }, { status: 400 })
      }
      const model = typeof item.model_override === 'string' ? item.model_override.trim().slice(0, MODEL_MAX) : ''
      rows.push({
        account_id: accountId,
        task: item.task,
        connection_id: connectionId,
        model_override: model || null,
        enabled: item.enabled !== false,
        updated_at: new Date().toISOString(),
      })
    }

    const { error } = await supabase.from('ai_task_routing').upsert(rows, { onConflict: 'account_id,task' })
    if (error) {
      console.error('[ai/routing PUT] error:', error)
      return NextResponse.json({ error: 'Failed to save routing' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
