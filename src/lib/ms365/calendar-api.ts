/**
 * Microsoft Graph Calendar API — event creation for Sembang "Schedule a
 * meeting" (P4). Named-params-object convention, matching mail-api.ts.
 * Uses the connected account's own OAuth token (src/lib/ms365/token.ts)
 * — the event's organizer is the one shared mailbox the account
 * connected as its Email channel, not the individual Sembang member
 * scheduling it (a deliberate product decision — see the P4 roadmap doc).
 */

import { throwGraphError } from './errors'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

export interface CreateCalendarEventArgs {
  accessToken: string
  title: string
  description?: string
  /** Naive local date-time — Graph rejects a `Z`/offset-bearing dateTime
   *  when `timeZone` is also set, so this must be exactly the same
   *  naive-plus-timeZone pair src/lib/gmail/calendar-api.ts takes. */
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

interface GraphEventResponse {
  id: string
  webLink: string
  onlineMeeting?: { joinUrl?: string }
}

/** Creates an Outlook Calendar event on the connected mailbox, with a
 *  Microsoft Teams meeting auto-generated. Real invite emails go out to
 *  every attendee — this is a genuine calendar write, not a simulation. */
export async function createCalendarEvent(args: CreateCalendarEventArgs): Promise<CreatedCalendarEvent> {
  const response = await fetch(`${GRAPH_BASE}/me/events`, {
    method: 'POST',
    headers: authHeaders(args.accessToken),
    body: JSON.stringify({
      subject: args.title,
      body: { contentType: 'Text', content: args.description ?? '' },
      start: { dateTime: args.startAt, timeZone: args.timeZone },
      end: { dateTime: args.endAt, timeZone: args.timeZone },
      attendees: args.attendeeEmails.map((email) => ({
        emailAddress: { address: email },
        type: 'required',
      })),
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    }),
  })
  if (!response.ok) {
    await throwGraphError(response, `events.create failed: ${response.status}`)
  }
  const data = (await response.json()) as GraphEventResponse
  return { eventId: data.id, htmlLink: data.webLink, meetingUrl: data.onlineMeeting?.joinUrl ?? null }
}
