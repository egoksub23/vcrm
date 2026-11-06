import { NextResponse } from 'next/server'
import { createAdminPgDb } from '@/lib/postgres/db'

export async function GET() {
  const { data, error } = await createAdminPgDb().rpc<boolean>('signup_is_open')
  if (error) return NextResponse.json({ open: null }, { status: 200 })
  return NextResponse.json({ open: data })
}
