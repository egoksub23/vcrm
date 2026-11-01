import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { createAdminPgDb } from '@/lib/postgres/db'
import { clearSampleComments, createSampleComments } from '@/lib/comments/samples'

/** POST /api/comments/test (admin) — add sample comments to try the screens. */
export async function POST() {
  try {
    const { accountId } = await requireCapability('channels.manage')
    const created = await createSampleComments(createAdminPgDb(), accountId)
    return NextResponse.json({ success: true, created })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/comments/test (admin) — remove the sample comments. */
export async function DELETE() {
  try {
    const { accountId } = await requireCapability('channels.manage')
    await clearSampleComments(createAdminPgDb(), accountId)
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
