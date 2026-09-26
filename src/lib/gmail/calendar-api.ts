/**
 * Google Calendar API — event creation for Sembang "Schedule a meeting"
 * (P4). Named-params-object convention, matching gmail-api.ts. Uses the
 * connected account's own OAuth token (src/lib/gmail/token.ts) — the
 * event's organizer is the one shared mailbox the account connected as
 * its Gmail channel, not the individual Sembang member scheduling it
 * (a deliberate product decision — see the P4 roadmap doc).
 */

import { throwGmailError } from './errors'

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

export interface CreateCalendarEventArgs {
  accessToken: string
  title: string
  description?: string
  /** Naive local date-time (no `Z`/offset — e.g. "2026-10-01T14:00:00"),
   *  paired with `timeZone` below. Google's Calendar API accepts either
   *  an offset-bearing RFC3339 dateTime OR a naive one plus an explicit
   *  IANA `timeZone` — this uses the latter so the same pair of values
   *  can be sent to Microsoft Graph unchanged (Graph only accepts the
   *  naive form). */
  startAt: string
  endAt: string
  timeZone: string
  attendeeEmails: string[]
}

export interface CreatedCalendarEvent {
  eventId: string
  htmlLink: string
  meetingUrl: string | null
}

interface CalendarEventResponse {
  id: string
  htmlLink: string
  hangoutLink?: string
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] }
}

/** Creates a Google Calendar event on the connected mailbox's primary
 *  calendar, with a Google Meet link auto-generated. Real invite emails
 *  go out to every attendee — this is a genuine calendar write, not a
 *  simulation. */
export async function createCalendarEvent(args: CreateCalendarEventArgs): Promise<CreatedCalendarEvent> {
  const response = await fetch(`${CALENDAR_API_BASE}/calendars/primary/events?conferenceDataVersion=1`, {
    method: 'POST',
    headers: authHeaders(args.accessToken),
    body: JSON.stringify({
      summary: args.title,
      description: args.description || undefined,
      start: { dateTime: args.startAt, timeZone: args.timeZone },
      end: { dateTime: args.endAt, timeZone: args.timeZone },
      attendees: args.attendeeEmails.map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    }),
  })
  if (!response.ok) {
    await throwGmailError(response, `calendar events.insert failed: ${response.status}`)
  }
  const data = (await response.json()) as CalendarEventResponse
  const meetingUrl =
    data.hangoutLink ?? data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? null
  return { eventId: data.id, htmlLink: data.htmlLink, meetingUrl }
}
