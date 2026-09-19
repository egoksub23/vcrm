import type { Tag } from '@/types';

/**
 * A tag row serves two lists — contact tags and conversation labels —
 * via two flags (migration 068). Rows fetched before that migration, or
 * built by hand, carry neither flag and count as both.
 */
export function isContactTag(tag: Pick<Tag, 'for_contacts'>): boolean {
  return tag.for_contacts !== false;
}

export function isConversationLabel(tag: Pick<Tag, 'for_conversations'>): boolean {
  return tag.for_conversations !== false;
}
