import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { clearSampleComments, createSampleComments } from '@/lib/comments/samples'

/** POST /api/comments/test (admin) — add sample comments to try the screens. */
export async function POST() {
  try {
    const { accountId } = await requireRole('admin')
    const created = await createSampleComments(supabaseAdmin(), accountId)
    return NextResponse.json({ success: true, created })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/comments/test (admin) — remove the sample comments. */
export async function DELETE() {
  try {
    const { accountId } = await requireRole('admin')
    await clearSampleComments(supabaseAdmin(), accountId)
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
