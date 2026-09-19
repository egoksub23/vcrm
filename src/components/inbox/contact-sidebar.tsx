"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useCan } from "@/hooks/use-can";
import { useTags } from "@/hooks/use-tags";
import { toast } from "sonner";
import { addContactTag, deleteContactTag } from "@/lib/contacts/tag-api";
import { addConversationLabel, deleteConversationLabel } from "@/lib/conversations/label-api";
import type { Contact, Deal, Tag } from "@/types";
import {
  Copy,
  Check,
  User,
  Tag as TagIcon,
  Bookmark,
  DollarSign,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslations } from "next-intl";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { ConversationSessionLog } from "./conversation-session-log";
import { ContactFieldsCard } from "./contact-fields-card";
import { TagChip } from "./tag-chip";
import { TagPicker } from "./tag-picker";

interface ContactSidebarProps {
  contact: Contact | null;
  /** Active conversation, for the session-log section (migration 065). */
  conversationId?: string | null;
  /** The conversation's labels (migration 044), owned by the inbox page. */
  labels?: Tag[];
  /** Called after a label is added/removed here so the list and thread header stay in step. */
  onLabelsChange?: (conversationId: string, labels: Tag[]) => void;
  /** Same, for the contact's own tags. */
  onContactTagsChange?: (contactId: string, tags: Tag[]) => void;
  /** Called after an inline edit of a contact field saves. */
  onContactUpdated?: (contactId: string, patch: Partial<Contact>) => void;
}

export function ContactSidebar({
  contact,
  conversationId = null,
  labels = [],
  onLabelsChange,
  onContactTagsChange,
  onContactUpdated,
}: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  // Tag/label writes go through the API (audit + automation triggers), one
  // at a time — `busy` ignores a second click while one is in flight.
  const [busy, setBusy] = useState(false);
  const canEdit = useCan("send-messages");
  const canManageFields = useCan("edit-settings");
  const { contactTags: tagOptions, conversationLabels: labelOptions } = useTags();

  const contactId = contact?.id ?? null;
  const fetchContactData = useCallback(async () => {
    if (!contactId) return;

    const supabase = createClient();

    // Fetch deals and tags in parallel (notes live in the column beside the chat).
    const [dealsRes, tagsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contactId),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ct.tags as Tag);
      setTags(mapped);
    }
    // Keyed on the id, not the object: the inbox page re-creates the
    // contact whenever its tags change, which must not refetch deals.
  }, [contactId]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    fetchContactData();
  }, [fetchContactData]);

  const handleToggleTag = useCallback(
    async (tag: Tag) => {
      if (!contactId || busy) return;
      const selected = tags.some((t) => t.id === tag.id);
      setBusy(true);
      try {
        if (selected) await deleteContactTag(contactId, tag.id);
        else await addContactTag(contactId, tag.id);
        const next = selected ? tags.filter((t) => t.id !== tag.id) : [...tags, tag];
        setTags(next);
        onContactTagsChange?.(contactId, next);
      } catch (err) {
        console.error("Failed to update contact tag:", err);
        toast.error(tSidebar("tagUpdateFailed"));
      } finally {
        setBusy(false);
      }
    },
    [contactId, busy, tags, onContactTagsChange, tSidebar],
  );

  const handleToggleLabel = useCallback(
    async (label: Tag) => {
      if (!conversationId || busy) return;
      const selected = labels.some((l) => l.id === label.id);
      setBusy(true);
      try {
        if (selected) await deleteConversationLabel(conversationId, label.id);
        else await addConversationLabel(conversationId, label.id);
        onLabelsChange?.(
          conversationId,
          selected ? labels.filter((l) => l.id !== label.id) : [...labels, label],
        );
      } catch (err) {
        console.error("Failed to update conversation label:", err);
        toast.error(tSidebar("labelUpdateFailed"));
      } finally {
        setBusy(false);
      }
    },
    [conversationId, busy, labels, onLabelsChange, tSidebar],
  );

  const handleCopyPhone = useCallback(async () => {
    // Copies whatever the row displays — a BSUID-only contact has no
    // phone number to copy, but its @username still identifies them.
    const handle = contact ? contactHandle(contact) : '';
    if (!handle) return;
    await navigator.clipboard.writeText(handle);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contactHandle(contact);
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full min-h-0 w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Contact fields — click a value to edit. Language is the
              customer's preferred conversation language (AI answers in it). */}
          <div className="mt-4">
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <User className="h-3 w-3" />
              <span className="flex-1">{tSidebar("contactFields")}</span>
              {canManageFields ? (
                <Link
                  href="/settings?tab=fields"
                  className="text-[10px] font-medium normal-case tracking-normal text-primary hover:underline"
                >
                  {tSidebar("manageFields")}
                </Link>
              ) : null}
            </div>
            <div className="mt-1">
              <ContactFieldsCard
                contact={contact}
                canEdit={canEdit}
                onUpdated={(id, patch) => onContactUpdated?.(id, patch)}
                phoneAction={
                  contactHandle(contact) ? (
                    <button
                      type="button"
                      onClick={handleCopyPhone}
                      aria-label={tSidebar("copyPhone")}
                      title={tSidebar("copyPhone")}
                      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
                    </button>
                  ) : null
                }
              />
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags — about the person; colour-coded, and shown on the
              conversation list too. */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              <span className="flex-1">{tSidebar("tags")}</span>
              {canEdit ? (
                <TagPicker
                  options={tagOptions}
                  selectedIds={new Set(tags.map((t) => t.id))}
                  onToggle={handleToggleTag}
                  disabled={busy}
                  addLabel={tSidebar("addTag")}
                  searchPlaceholder={tSidebar("searchTags")}
                  emptyLabel={tSidebar("noTagsDefined")}
                  noMatchesLabel={tSidebar("noMatches")}
                />
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                tags.map((tag) => (
                  <TagChip
                    key={tag.id}
                    tag={tag}
                    kind="tag"
                    onRemove={canEdit ? () => handleToggleTag(tag) : undefined}
                    removeLabel={tSidebar("removeTag", { name: tag.name })}
                  />
                ))
              )}
            </div>
          </div>

          {/* Conversation labels — about this conversation's topic. */}
          {conversationId ? (
            <>
              <div className="my-4 border-t border-border" />
              <div>
                <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <Bookmark className="h-3 w-3" />
                  <span className="flex-1">{tSidebar("labels")}</span>
                  {canEdit ? (
                    <TagPicker
                      options={labelOptions}
                      selectedIds={new Set(labels.map((l) => l.id))}
                      onToggle={handleToggleLabel}
                      disabled={busy}
                      addLabel={tSidebar("addLabel")}
                      searchPlaceholder={tSidebar("searchLabels")}
                      emptyLabel={tSidebar("noLabelsDefined")}
                      noMatchesLabel={tSidebar("noMatches")}
                    />
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {labels.length === 0 ? (
                    <p className="px-1 text-xs text-muted-foreground">{tSidebar("noLabels")}</p>
                  ) : (
                    labels.map((label) => (
                      <TagChip
                        key={label.id}
                        tag={label}
                        kind="label"
                        onRemove={canEdit ? () => handleToggleLabel(label) : undefined}
                        removeLabel={tSidebar("removeLabel", { name: label.name })}
                      />
                    ))
                  )}
                </div>
              </div>
            </>
          ) : null}

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              {tSidebar("deals")}
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noDeals")}</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Session log (migration 065) */}
          <ConversationSessionLog conversationId={conversationId} />
        </div>
      </ScrollArea>
    </div>
  );
}
