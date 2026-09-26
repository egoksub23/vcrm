// ============================================================
// /api/sembang/channels/[id]/schedule
//
//   POST — "Schedule a meeting" (P4). Creates a real calendar event via
//          whichever of the account's connected Google/Microsoft 365
//          channels the caller picked (`provider`), with every other
//          member of this Sembang channel invited as an attendee.
//
//          The event's organizer is the account's ONE shared connected
//          mailbox (e.g. support@company.com), not the individual
//          member scheduling it — a deliberate product decision (see
//          the Sembang roadmap doc's P4 entry). Reuses the exact same
//          token storage/refresh/encryption every other feature of that
//          channel already relies on (src/lib/gmail/token.ts,
//          src/lib/ms365/token.ts) — no new OAuth flow, no new table.
//
//          `gmail_config`/`email_config` SELECT is open to any account
//          member (migrations 056/058) — only connecting/disconnecting
//          the channel itself is admin-gated — so this deliberately
//          reads through the caller's own session, not a service-role
//          client.
//
// Returns `{ eventId, htmlLink, meetingUrl, attendeeCount }`.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { getValidAccessToken as getValidGoogleAccessToken } from '@/lib/gmail/token'
import { createCalendarEvent as createGoogleCalendarEvent } from '@/lib/gmail/calendar-api'
import { getValidAccessToken as getValidMs365AccessToken } from '@/lib/ms365/token'
import { createCalendarEvent as createMs365CalendarEvent } from '@/lib/ms365/calendar-api'

const TITLE_MAX = 200
const DESCRIPTION_MAX = 2000

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId } = await params

    const payload = (await request.json().catch(() => null)) as {
      provider?: unknown
      title?: unknown
      description?: unknown
      startAt?: unknown
      endAt?: unknown
      timeZone?: unknown
    } | null

    const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
    if (!title || title.length > TITLE_MAX) {
      return NextResponse.json({ error: `Title must be between 1 and ${TITLE_MAX} characters` }, { status: 400 })
    }
    const description =
      typeof payload?.description === 'string' ? payload.description.trim().slice(0, DESCRIPTION_MAX) : ''

    const startAt = typeof payload?.startAt === 'string' ? payload.startAt : ''
    const endAt = typeof payload?.endAt === 'string' ? payload.endAt : ''
    if (!startAt || !endAt || Number.isNaN(Date.parse(startAt)) || Number.isNaN(Date.parse(endAt))) {
      return NextResponse.json({ error: 'A valid start and end time are required' }, { status: 400 })
    }
    if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
      return NextResponse.json({ error: 'End time must be after the start time' }, { status: 400 })
    }
    const timeZone = typeof payload?.timeZone === 'string' && payload.timeZone ? payload.timeZone : 'UTC'

    const provider = payload?.provider === 'ms365' ? 'ms365' : payload?.provider === 'google' ? 'google' : null
    if (!provider) {
      return NextResponse.json({ error: 'A calendar provider must be selected' }, { status: 400 })
    }

    // Every other member of this channel, by email — calendar providers
    // already add the organizer (the connected mailbox) on their own.
    const { data: memberRows } = await ctx.supabase
      .from('sembang_channel_members')
      .select('user_id')
      .eq('channel_id', channelId)
    const memberIds = (memberRows ?? [])
      .map((m) => m.user_id as string)
      .filter((userId) => userId !== ctx.userId)
    const { data: profileRows } =
      memberIds.length > 0
        ? await ctx.supabase.from('profiles').select('email').in('user_id', memberIds)
        : { data: [] as { email: string | null }[] }
    const attendeeEmails = Array.from(
      new Set((profileRows ?? []).map((p) => p.email).filter((e): e is string => !!e)),
    )

    let created: { eventId: string; htmlLink: string; meetingUrl: string | null }
    try {
      if (provider === 'google') {
        const { data: config, error } = await ctx.supabase
          .from('gmail_config')
          .select('*')
          .eq('account_id', ctx.accountId)
          .maybeSingle()
        if (error || !config) {
          return NextResponse.json({ error: 'Google is not connected for this account' }, { status: 400 })
        }
        const accessToken = await getValidGoogleAccessToken(config as never)
        created = await createGoogleCalendarEvent({
          accessToken,
          title,
          description,
          startAt,
          endAt,
          timeZone,
          attendeeEmails,
        })
      } else {
        const { data: config, error } = await ctx.supabase
          .from('email_config')
          .select('*')
          .eq('account_id', ctx.accountId)
          .maybeSingle()
        if (error || !config) {
          return NextResponse.json({ error: 'Microsoft 365 is not connected for this account' }, { status: 400 })
        }
        const accessToken = await getValidMs365AccessToken(config as never)
        created = await createMs365CalendarEvent({
          accessToken,
          title,
          description,
          startAt,
          endAt,
          timeZone,
          attendeeEmails,
        })
      }
    } catch (err) {
      console.error('[POST /api/sembang/channels/[id]/schedule] calendar API error:', err)
      return NextResponse.json(
        { error: 'Failed to create the calendar event. The connected account may need reconnecting.' },
        { status: 502 },
      )
    }

    return NextResponse.json({
      eventId: created.eventId,
      htmlLink: created.htmlLink,
      meetingUrl: created.meetingUrl,
      attendeeCount: attendeeEmails.length,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
