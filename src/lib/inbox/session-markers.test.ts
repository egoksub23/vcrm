import { describe, it, expect } from 'vitest'
import type { ConversationEvent, Message } from '@/types'
import {
  buildSessionMarkers,
  isMarkerId,
  markerEventId,
  mergeMarkersIntoTimeline,
} from './session-markers'

function ev(over: Partial<ConversationEvent> & { id: string }): ConversationEvent {
  return {
    conversation_id: 'c1',
    event_type: 'closed',
    actor_user_id: 'u1',
    note: 'done',
    metadata: {},
    created_at: '2026-09-18T22:40:00Z',
    ...over,
  }
}
const msg = (id: string, at: string) => ({ id, created_at: at }) as Message

describe('buildSessionMarkers', () => {
  it('keeps only closed and reopened events', () => {
    const out = buildSessionMarkers(
      [ev({ id: 'a' }), ev({ id: 'b', event_type: 'assigned' }), ev({ id: 'c', event_type: 'reopened' })],
      { id: 'c1', status: 'open' },
    )
    expect(out.map((e) => e.id)).toEqual(['a', 'c'])
  })

  it('adds a legacy "closed" marker for a conversation closed before event logging', () => {
    const out = buildSessionMarkers([], { id: 'c1', status: 'closed', closed_at: '2026-09-10T08:00:00Z' })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ event_type: 'closed', actor_user_id: null, note: null })
    expect(out[0].metadata.legacy).toBe('1')
  })

  it('does not add a legacy marker when a real closed event exists, or when the conversation is open', () => {
    expect(buildSessionMarkers([ev({ id: 'a' })], { id: 'c1', status: 'closed', closed_at: '2026-09-18T22:40:00Z' })).toHaveLength(1)
    expect(buildSessionMarkers([], { id: 'c1', status: 'open', closed_at: null })).toEqual([])
  })
})

describe('mergeMarkersIntoTimeline', () => {
  it('slots a marker between messages by timestamp and round-trips its id', () => {
    const merged = mergeMarkersIntoTimeline(
      [msg('m1', '2026-09-18T22:00:00Z'), msg('m2', '2026-09-19T08:00:00Z')],
      [ev({ id: 'e1', created_at: '2026-09-18T22:40:00Z' })],
    )
    expect(merged.map((m) => m.id)).toEqual(['m1', 'session-marker:e1', 'm2'])
    expect(isMarkerId(merged[1].id)).toBe(true)
    expect(markerEventId(merged[1].id)).toBe('e1')
    expect(isMarkerId('m1')).toBe(false)
  })

  it('puts a marker after a message with the same timestamp', () => {
    const merged = mergeMarkersIntoTimeline(
      [msg('m1', '2026-09-18T22:40:00Z')],
      [ev({ id: 'e1', created_at: '2026-09-18T22:40:00Z' })],
    )
    expect(merged.map((m) => m.id)).toEqual(['m1', 'session-marker:e1'])
  })

  it('returns the same list when there are no markers', () => {
    const list = [msg('m1', '2026-09-18T22:00:00Z')]
    expect(mergeMarkersIntoTimeline(list, [])).toBe(list)
  })
})
