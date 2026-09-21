import { describe, expect, it } from 'vitest'
import type { TicketResolution } from '@/types'
import {
  RESOLUTION_NOTE_MAX,
  activeResolutions,
  anyNeedsResolutionPrompt,
  needsResolutionPrompt,
  resolutionColumns,
  resolutionErrorCode,
  resolutionName,
  showsResolution,
  validateResolutionChoice,
  withResolution,
} from './resolution'

const res = (id: string, name: string, over: Partial<TicketResolution> = {}): TicketResolution => ({
  id,
  account_id: 'a',
  name,
  position: 0,
  is_active: true,
  is_system: false,
  system_key: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  ...over,
})

const CATALOGUE = [
  res('r2', 'Duplicate', { position: 30 }),
  res('r1', 'Fixed', { position: 10 }),
  res('r3', 'Old one', { position: 20, is_active: false }),
  res('r4', 'Closed automatically', { position: 80, is_system: true, system_key: 'closed_automatically' }),
]

describe('activeResolutions', () => {
  it('drops archived ones and orders by position', () => {
    expect(activeResolutions(CATALOGUE).map((r) => r.id)).toEqual(['r1', 'r2', 'r4'])
  })
  it('breaks a tie on position by name', () => {
    const tied = [res('b', 'Zeta'), res('a', 'Alpha')]
    expect(activeResolutions(tied).map((r) => r.name)).toEqual(['Alpha', 'Zeta'])
  })
})

describe('needsResolutionPrompt', () => {
  it('asks when a ticket enters Resolved or Closed from an active status', () => {
    for (const from of ['open', 'in_progress', 'pending'] as const) {
      expect(needsResolutionPrompt(from, 'resolved', null)).toBe(true)
      expect(needsResolutionPrompt(from, 'closed', null)).toBe(true)
    }
  })
  it('asks again after a re-open even though the old resolution was kept', () => {
    expect(needsResolutionPrompt('open', 'resolved', 'r1')).toBe(true)
  })
  it('does not ask for a move to an active status', () => {
    expect(needsResolutionPrompt('resolved', 'open', 'r1')).toBe(false)
    expect(needsResolutionPrompt('closed', 'pending', null)).toBe(false)
    expect(needsResolutionPrompt('open', 'in_progress', null)).toBe(false)
  })
  it('does not ask when nothing changes', () => {
    expect(needsResolutionPrompt('resolved', 'resolved', null)).toBe(false)
  })
  it('moving Resolved to Closed only asks when there is no resolution yet (tickets from before)', () => {
    expect(needsResolutionPrompt('resolved', 'closed', 'r1')).toBe(false)
    expect(needsResolutionPrompt('resolved', 'closed', null)).toBe(true)
    expect(needsResolutionPrompt('closed', 'resolved', undefined)).toBe(true)
  })
})

describe('anyNeedsResolutionPrompt (bulk: one dialog for all)', () => {
  it('asks when at least one selected ticket needs it', () => {
    expect(
      anyNeedsResolutionPrompt(
        [
          { status: 'resolved', resolution_id: 'r1' },
          { status: 'open', resolution_id: null },
        ],
        'closed',
      ),
    ).toBe(true)
  })
  it('does not ask when every ticket already has one and is done', () => {
    expect(anyNeedsResolutionPrompt([{ status: 'resolved', resolution_id: 'r1' }], 'closed')).toBe(false)
  })
  it('does not ask for an active target', () => {
    expect(anyNeedsResolutionPrompt([{ status: 'open', resolution_id: null }], 'pending')).toBe(false)
  })
})

describe('validateResolutionChoice', () => {
  const active = activeResolutions(CATALOGUE)
  it('needs a resolution', () => {
    expect(validateResolutionChoice({ resolutionId: null, note: '', active })).toBe('choose')
  })
  it('refuses an archived or unknown one', () => {
    expect(validateResolutionChoice({ resolutionId: 'r3', note: '', active })).toBe('unavailable')
    expect(validateResolutionChoice({ resolutionId: 'nope', note: '', active })).toBe('unavailable')
  })
  it('accepts a chosen one, with or without a note', () => {
    expect(validateResolutionChoice({ resolutionId: 'r1', note: '', active })).toBeNull()
    expect(validateResolutionChoice({ resolutionId: 'r1', note: 'Restarted it', active })).toBeNull()
  })
  it('holds the note to 2000 characters', () => {
    expect(RESOLUTION_NOTE_MAX).toBe(2000)
    expect(validateResolutionChoice({ resolutionId: 'r1', note: 'x'.repeat(2000), active })).toBeNull()
    expect(validateResolutionChoice({ resolutionId: 'r1', note: 'x'.repeat(2001), active })).toBe('noteTooLong')
  })
})

describe('resolutionColumns / withResolution', () => {
  it('trims the note and turns an empty one into null', () => {
    expect(resolutionColumns({ resolutionId: 'r1', note: '  did it  ' })).toEqual({ resolution_id: 'r1', resolution_note: 'did it' })
    expect(resolutionColumns({ resolutionId: 'r1', note: '   ' })).toEqual({ resolution_id: 'r1', resolution_note: null })
    expect(resolutionColumns({ resolutionId: 'r1', note: null })).toEqual({ resolution_id: 'r1', resolution_note: null })
  })
  it('adds the resolution to a patch that moves to Resolved or Closed', () => {
    expect(withResolution({ status: 'resolved' }, { resolutionId: 'r1', note: 'n' })).toEqual({
      status: 'resolved',
      resolution_id: 'r1',
      resolution_note: 'n',
    })
  })
  it('leaves other patches alone', () => {
    expect(withResolution({ status: 'open' }, { resolutionId: 'r1', note: 'n' })).toEqual({ status: 'open' })
    expect(withResolution({ priority: 'high' }, { resolutionId: 'r1', note: null })).toEqual({ priority: 'high' })
    expect(withResolution({ status: 'closed' }, null)).toEqual({ status: 'closed' })
  })
})

describe('resolutionErrorCode', () => {
  it('reads the codes the database raises', () => {
    expect(resolutionErrorCode({ message: 'resolution_required', code: '22023' })).toBe('resolution_required')
    expect(resolutionErrorCode({ message: 'resolution_invalid', code: '22023' })).toBe('resolution_invalid')
  })
  it('is null for anything else', () => {
    expect(resolutionErrorCode({ message: 'permission denied', code: '42501' })).toBeNull()
    expect(resolutionErrorCode(null)).toBeNull()
    expect(resolutionErrorCode(undefined)).toBeNull()
  })
})

describe('display helpers', () => {
  const byId = new Map(CATALOGUE.map((r) => [r.id, r]))
  it('names an archived resolution and shows nothing for an unknown one', () => {
    expect(resolutionName(byId, 'r3')).toBe('Old one')
    expect(resolutionName(byId, 'zzz')).toBeNull()
    expect(resolutionName(byId, null)).toBeNull()
  })
  it('shows the resolution only while the ticket is Resolved or Closed', () => {
    expect(showsResolution({ status: 'resolved', resolution_id: 'r1' })).toBe(true)
    expect(showsResolution({ status: 'closed', resolution_id: 'r1' })).toBe(true)
    expect(showsResolution({ status: 'open', resolution_id: 'r1' })).toBe(false)
    expect(showsResolution({ status: 'resolved', resolution_id: null })).toBe(false)
  })
})
