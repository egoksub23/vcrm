import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getPool } from '@/lib/postgres/client'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function PATCH(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => null)) as { email?: string } | null
    if (!body?.email) return NextResponse.json({ error: 'email required' }, { status: 400 })

    const newEmail = body.email.trim().toLowerCase()
    if (!EMAIL_RE.test(newEmail)) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
    }

    const sql = getPool()
    await sql`
      UPDATE auth.users
         SET email              = ${newEmail},
             email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
             updated_at         = NOW()
       WHERE id = ${ctx.userId}::uuid
    `
    await sql`
      UPDATE public.profiles
         SET email      = ${newEmail},
             updated_at = NOW()
       WHERE user_id = ${ctx.userId}::uuid
    `

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
