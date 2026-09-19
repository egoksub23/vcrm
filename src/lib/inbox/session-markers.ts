import type { ConversationEvent, Message } from '@/types'

/**
 * Staff-only "session" markers shown inline in the chat thread: when a
 * conversation was closed (and by whom, with what note) or reopened. They
 * come from `conversation_events` (migration 065) and are never sent to
 * the customer — the thread renders them as a centered rule, like the
 * date separators.
 */

const MARKER_PREFIX = 'session-marker:'

export function isMarkerId(id: string): boolean {
  return id.startsWith(MARKER_PREFIX)
}

export function markerEventId(id: string): string {
  return id.slice(MARKER_PREFIX.length)
}

/**
 * The closed/reopened events to show. A conversation closed BEFORE
 * migration 065 has `closed_at` but no event row, so its who/why is
 * unknowable — show a bare "Closed" marker at that time rather than
 * nothing (flagged by `metadata.legacy`).
 */
export function buildSessionMarkers(
  events: ConversationEvent[],
  conversation: { id: string; status: string; closed_at?: string | null },
): ConversationEvent[] {
  const markers = events.filter((e) => e.event_type === 'closed' || e.event_type === 'reopened')
  const hasClosedEvent = markers.some((e) => e.event_type === 'closed')
  if (conversation.status === 'closed' && conversation.closed_at && !hasClosedEvent) {
    markers.push({
      id: `legacy-${conversation.id}`,
      conversation_id: conversation.id,
      event_type: 'closed',
      actor_user_id: null,
      note: null,
      metadata: { legacy: '1' },
      created_at: conversation.closed_at,
    })
  }
  return markers
}

/** Merge markers into the message list by time (a marker sorts after a
 *  message with the same timestamp). Markers ride along as synthetic
 *  Message rows so the thread's existing date grouping applies to them
 *  unchanged; the renderer recognises them by `isMarkerId`. */
export function mergeMarkersIntoTimeline(
  messages: Message[],
  markers: ConversationEvent[],
): Message[] {
  if (markers.length === 0) return messages
  const synthetic = markers.map(
    (e) =>
      ({
        id: `${MARKER_PREFIX}${e.id}`,
        conversation_id: e.conversation_id,
        sender_type: 'bot',
        content_type: 'text',
        channel_type: 'whatsapp',
        status: 'sent',
        created_at: e.created_at,
      }) as Message,
  )
  return [...messages, ...synthetic].sort((a, b) => {
    const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    if (diff !== 0) return diff
    return Number(isMarkerId(a.id)) - Number(isMarkerId(b.id))
  })
}
