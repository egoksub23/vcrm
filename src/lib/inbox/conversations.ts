import type { Conversation, Contact, Tag } from "@/types";

/**
 * Conversation select that embeds the contact plus its tags, and the
 * conversation's own labels, so the Inbox can filter by either without
 * a second round-trip. `contact_tags(tags(*))` / `conversation_labels(tags(*))`
 * return the join rows; {@link normalizeConversation} flattens them onto
 * `contact.tags` / `labels`.
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*, contact_tags(tags(*))), conversation_labels(tags(*))";

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, "contact" | "labels"> & {
  contact?: RawContact | null;
  conversation_labels?: { tags: Tag | null }[];
};

/**
 * Flatten the embedded `contact_tags(tags(*))` and `conversation_labels(tags(*))`
 * joins into `contact.tags` / `labels`. Safe to call on rows fetched with
 * {@link CONVERSATION_SELECT}; a row with no contact (e.g. a freshly-inserted
 * conversation) passes through untouched for the contact side.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const { conversation_labels, contact: rawContact, ...rest } = raw;
  const labels = (conversation_labels ?? [])
    .map((cl) => cl.tags)
    .filter((t): t is Tag => t != null);

  // Preserve the original contact value (null vs undefined) when there's
  // nothing to flatten — consumers use `?.` either way, but a round-trip
  // test asserts `contact: null` survives untouched.
  if (!rawContact) return { ...rest, contact: rawContact, labels } as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...rest,
    labels,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[],
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}
