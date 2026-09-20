import type { TicketLink, TicketLinkType } from '@/types'

/** A link as one ticket sees it: the stored type plus which end it is. */
export type LinkGroupKey = 'blocks' | 'blocked_by' | 'relates' | 'duplicates' | 'duplicated_by'

export const LINK_GROUP_ORDER: LinkGroupKey[] = [
  'blocks',
  'blocked_by',
  'relates',
  'duplicates',
  'duplicated_by',
]

/** The same link seen from the other ticket. */
export function invertLinkGroup(key: LinkGroupKey): LinkGroupKey {
  switch (key) {
    case 'blocks':
      return 'blocked_by'
    case 'blocked_by':
      return 'blocks'
    case 'duplicates':
      return 'duplicated_by'
    case 'duplicated_by':
      return 'duplicates'
    default:
      return 'relates'
  }
}

/** How `link` reads from the point of view of ticket `ticketId`. */
export function linkGroupFor(
  link: Pick<TicketLink, 'from_ticket_id' | 'link_type'>,
  ticketId: string,
): LinkGroupKey {
  return link.from_ticket_id === ticketId ? link.link_type : invertLinkGroup(link.link_type)
}

/** The row to store when `current` is linked to `other` as `group` says
 *  ("current is blocked by other" is stored as other blocks current). */
export function linkRowFor(
  group: LinkGroupKey,
  currentId: string,
  otherId: string,
): { from_ticket_id: string; to_ticket_id: string; link_type: TicketLinkType } {
  switch (group) {
    case 'blocks':
      return { from_ticket_id: currentId, to_ticket_id: otherId, link_type: 'blocks' }
    case 'blocked_by':
      return { from_ticket_id: otherId, to_ticket_id: currentId, link_type: 'blocks' }
    case 'duplicates':
      return { from_ticket_id: currentId, to_ticket_id: otherId, link_type: 'duplicates' }
    case 'duplicated_by':
      return { from_ticket_id: otherId, to_ticket_id: currentId, link_type: 'duplicates' }
    default:
      return { from_ticket_id: currentId, to_ticket_id: otherId, link_type: 'relates' }
  }
}

export interface LinkGroup {
  key: LinkGroupKey
  items: { link: TicketLink; otherId: string }[]
}

/** A ticket's links grouped for display, in a fixed order, empty groups left out. */
export function groupLinks(ticketId: string, links: TicketLink[]): LinkGroup[] {
  const groups = new Map<LinkGroupKey, LinkGroup>()
  for (const link of links) {
    if (link.from_ticket_id !== ticketId && link.to_ticket_id !== ticketId) continue
    const key = linkGroupFor(link, ticketId)
    const otherId = link.from_ticket_id === ticketId ? link.to_ticket_id : link.from_ticket_id
    const group = groups.get(key) ?? { key, items: [] }
    group.items.push({ link, otherId })
    groups.set(key, group)
  }
  return LINK_GROUP_ORDER.filter((k) => groups.has(k)).map((k) => groups.get(k)!)
}
