import type { TicketCategory, TicketPriority, TicketStatus } from '@/types'

/** Workflow order: the board's columns left to right. */
export const TICKET_STATUSES: TicketStatus[] = [
  'open',
  'in_progress',
  'pending',
  'resolved',
  'closed',
]

/** Most urgent first. */
export const TICKET_PRIORITIES: TicketPriority[] = ['urgent', 'high', 'normal', 'low']

/** Shown to agents as the ticket "Type". The DB column is still `category`. */
export const TICKET_CATEGORIES: TicketCategory[] = [
  'bug',
  'feature_request',
  'technical',
  'billing',
  'account',
  'general',
  'other',
]

/** Statuses that still need work (the backlog). */
export const ACTIVE_STATUSES: TicketStatus[] = ['open', 'in_progress', 'pending']

export function isActiveStatus(status: TicketStatus): boolean {
  return ACTIVE_STATUSES.includes(status)
}

export function isDoneStatus(status: TicketStatus): boolean {
  return status === 'resolved' || status === 'closed'
}

/**
 * Every status except `current`, the ones an agent most likely wants next
 * first (Jira's "valid transitions" first), then the rest.
 */
export function orderedTransitions(current: TicketStatus): TicketStatus[] {
  const preferred: Record<TicketStatus, TicketStatus[]> = {
    open: ['in_progress', 'pending', 'resolved', 'closed'],
    in_progress: ['resolved', 'pending', 'open', 'closed'],
    pending: ['in_progress', 'resolved', 'open', 'closed'],
    resolved: ['closed', 'open', 'in_progress', 'pending'],
    closed: ['open', 'in_progress', 'pending', 'resolved'],
  }
  return preferred[current]
}

/** Tickets fetched per page of the list view. */
export const LIST_PAGE_SIZE = 200
/** Tickets fetched per board column (and per "Show more"). */
export const BOARD_COLUMN_PAGE_SIZE = 100
