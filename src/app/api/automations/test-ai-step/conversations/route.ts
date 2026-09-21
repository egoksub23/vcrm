import { NextResponse } from 'next/server'
import { assertCapability, requireCapability, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/automations/test-ai-step/conversations?q=
 *
 * The recent conversations the Test panel lets you pick from, newest first,
 * searchable by the customer's name, phone number or the last message. Same
 * capabilities as the test itself. Read-only, through the caller's own
 * (RLS-scoped) client, so an agent only sees conversations they can see.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireCapability('automations.manage')
    assertCapability(ctx, 'ai.use')
    const { supabase, accountId } = ctx

    const q = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, 60)
    // PostgREST filter values: drop the characters that mean something in an
    // `or()` expression so a search can never rewrite the filter.
    const safe = q.replace(/[%,()*\\]/g, ' ').trim()

    let contactIds: string[] | null = null
    if (safe) {
      const { data: contacts } = await supabase
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .or(`name.ilike.%${safe}%,phone.ilike.%${safe}%,email.ilike.%${safe}%`)
        .limit(50)
      contactIds = ((contacts ?? []) as { id: string }[]).map((c) => c.id)
    }

    let query = supabase
      .from('conversations')
      .select('id, status, last_message_text, last_message_at, contact:contacts(name, phone)')
      .eq('account_id', accountId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(20)
    if (safe) {
      const ids = contactIds ?? []
      query = query.or(
        ids.length > 0
          ? `contact_id.in.(${ids.join(',')}),last_message_text.ilike.%${safe}%`
          : `last_message_text.ilike.%${safe}%`,
      )
    }
    const { data, error } = await query
    if (error) return NextResponse.json({ error: 'Failed to load conversations' }, { status: 500 })

    const conversations = ((data ?? []) as unknown as {
      id: string
      status: string
      last_message_text: string | null
      last_message_at: string | null
      contact: { name?: string | null; phone?: string | null } | { name?: string | null; phone?: string | null }[] | null
    }[]).map((c) => {
      const contact = Array.isArray(c.contact) ? c.contact[0] : c.contact
      return {
        id: c.id,
        status: c.status,
        name: contact?.name || contact?.phone || '',
        preview: (c.last_message_text ?? '').slice(0, 120),
        last_message_at: c.last_message_at,
      }
    })
    return NextResponse.json({ conversations })
  } catch (err) {
    return toErrorResponse(err)
  }
}
