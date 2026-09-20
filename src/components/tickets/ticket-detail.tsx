"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Eye, EyeOff, Link2, Loader2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ContactDetailView } from "@/components/contacts/contact-detail-view";
import { useAccountMembers } from "@/hooks/use-account-members";
import { useAuth } from "@/hooks/use-auth";
import { useCapability } from "@/hooks/use-can";
import { useTeams } from "@/hooks/use-teams";
import { useTicketDetail } from "@/hooks/use-ticket-detail";
import { useTicketJira } from "@/hooks/use-ticket-jira";
import { errorKeyOf, loose, retrySeconds } from "@/lib/tickets/jira-ui";
import { useTicketFields } from "@/hooks/use-ticket-fields";
import { useTicketKeyPrefix } from "@/hooks/use-ticket-key-prefix";
import { useTicketLabels } from "@/hooks/use-ticket-labels";
import { pastedImages } from "@/lib/media/clipboard-images";
import type { Ticket, TicketAttachment } from "@/types";
import { TicketActivitySection } from "./ticket-activity";
import { TicketAttachmentsSection } from "./ticket-attachments";
import { CustomFieldsSection } from "./ticket-custom-fields";
import { TicketDetailsCard } from "./ticket-details-card";
import { TicketJiraSection } from "./ticket-jira-section";
import { TicketLinksSection } from "./ticket-links";
import { TypeIcon } from "./ticket-visuals";

/** The summary: click to edit, Enter (or leaving the box) saves, Esc cancels. */
function InlineSummary({
  value,
  disabled,
  onSave,
}: {
  value: string;
  disabled: boolean;
  onSave: (next: string) => void;
}) {
  const t = useTranslations("Tickets.detail");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const finish = (save: boolean) => {
    setEditing(false);
    const next = draft.trim();
    if (save && next && next !== value) onSave(next);
  };

  if (editing) {
    return (
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            // Cancels the edit only; it must not also close the ticket.
            e.stopPropagation();
            finish(false);
          }
        }}
        maxLength={200}
        autoFocus
        aria-label={t("summary")}
        className="w-full rounded-md border border-ring bg-background px-2 py-1 text-xl font-semibold outline-none ring-2 ring-ring/30"
      />
    );
  }
  return (
    <h2 className="-mx-2 rounded-md px-2 py-1 text-xl leading-snug font-semibold break-words text-foreground">
      {disabled ? (
        value
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          title={t("editSummary")}
          className="w-full cursor-text rounded-md text-left hover:bg-muted/70"
        >
          {value}
        </button>
      )}
    </h2>
  );
}

/** The description: click to edit in a textarea with Save / Cancel; whitespace is kept. */
function DescriptionSection({
  value,
  disabled,
  onSave,
}: {
  value: string;
  disabled: boolean;
  onSave: (next: string) => void;
}) {
  const t = useTranslations("Tickets.detail");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const save = () => {
    setEditing(false);
    if (draft !== value) onSave(draft);
  };

  return (
    <section className="space-y-1.5">
      <h3 className="text-[13px] font-semibold text-foreground">{t("descriptionHeading")}</h3>
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            autoFocus
            aria-label={t("descriptionHeading")}
            placeholder={t("descriptionPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
              }
            }}
            className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-primary/50"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={save}>
              {t("save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
          className="-mx-2 block w-[calc(100%+1rem)] cursor-text rounded-md px-2 py-1.5 text-left text-[13px] leading-relaxed whitespace-pre-wrap hover:bg-muted/70 disabled:cursor-default disabled:hover:bg-transparent"
        >
          {value ? value : <span className="text-muted-foreground">{t("descriptionPlaceholder")}</span>}
        </button>
      )}
    </section>
  );
}

/**
 * A ticket as a Jira-style issue view: header (breadcrumb, key, copy link,
 * watch, menu), and two columns. Left: summary, description, attachments,
 * linked tickets, custom fields, activity. Right: the status transition
 * button and the Details card. Used inside the modal (`variant="modal"`) and
 * as the full page at /tickets/[id] (`variant="page"`).
 */
export function TicketDetail({
  ticketId,
  variant,
  onClose,
  onChanged,
  onDeleted,
  onOpenTicket,
}: {
  ticketId: string;
  variant: "modal" | "page";
  onClose: () => void;
  /** A field changed (with the patch) or comments changed: lets the list refresh its row. */
  onChanged?: (id: string, patch?: Partial<Ticket>) => void;
  onDeleted?: (id: string) => void;
  onOpenTicket: (id: string) => void;
}) {
  const t = useTranslations("Tickets.detail");
  const { user, accountRole } = useAuth();
  const canWork = useCapability("tickets.work");
  const canDelete = useCapability("tickets.delete");
  const { members } = useAccountMembers();
  const { teams } = useTeams();
  const { keyOf } = useTicketKeyPrefix();
  const { labels: knownLabels } = useTicketLabels();
  const { fields: fieldDefs } = useTicketFields(true);

  const detail = useTicketDetail(ticketId, {
    onChanged,
    onDeleted: (id) => {
      onDeleted?.(id);
      onClose();
    },
  });
  const { ticket } = detail;

  // Jira: cached link rows for the section and the "Share with Jira" action of the notes.
  const jira = useTicketJira(ticketId);
  const tJira = useTranslations("Jira");
  const canShareJira = useCapability("jira.share-comments") && jira.connected && jira.commentsToJira && jira.hasOkLink;
  const shareNoteToJira = async (noteId: string): Promise<boolean> => {
    const r = await jira.shareNote(noteId);
    if (!r.ok) {
      toast.error(loose(tJira)(`errors.${errorKeyOf(r.code)}`, { seconds: retrySeconds(r.retryAfterSeconds) }));
      return false;
    }
    const failed = (r.data.results ?? []).find((x) => !x.ok);
    if (failed) {
      toast.error(loose(tJira)(`errors.${errorKeyOf(failed.code)}`, { seconds: 30 }));
      return false;
    }
    toast.success(r.data.queued ? tJira("share.queued") : tJira("share.done"));
    return true;
  };

  const [contactOpen, setContactOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isAdminTier = accountRole === "owner" || accountRole === "admin";
  const canRemoveAttachment = (a: TicketAttachment) =>
    canWork && (a.uploaded_by === user?.id || isAdminTier);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/tickets/${ticketId}`);
      toast.success(t("linkCopied"));
    } catch {
      toast.error(t("linkCopyFailed"));
    }
  };

  // A picture pasted anywhere in the ticket becomes an attachment (text pastes
  // are left alone: see pastedImages).
  const handlePaste = (e: React.ClipboardEvent) => {
    if (!canWork) return;
    const images = pastedImages(e.clipboardData?.files, e.clipboardData?.getData("text/plain"));
    if (images.length === 0) return;
    e.preventDefault();
    void detail.addFiles(images);
  };

  if (detail.loading) {
    return (
      <div className="flex min-h-64 flex-1 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }
  if (!ticket) {
    return (
      <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
        <Button variant="outline" size="sm" onClick={onClose}>
          {variant === "modal" ? t("close") : t("backToTickets")}
        </Button>
      </div>
    );
  }

  const key = keyOf(ticket.ticket_number);

  return (
    <div className="flex min-h-0 flex-1 flex-col" onPaste={handlePaste}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 pr-12 sm:px-6">
        <nav aria-label={t("breadcrumb")} className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          {variant === "page" ? (
            <Link href="/tickets" className="hover:text-foreground hover:underline">
              {t("tickets")}
            </Link>
          ) : (
            <button type="button" onClick={onClose} className="hover:text-foreground hover:underline">
              {t("tickets")}
            </button>
          )}
          <span aria-hidden>/</span>
          <TypeIcon category={ticket.category} />
          <span className="font-mono font-medium text-foreground">{key}</span>
        </nav>
        {detail.saving ? <span className="text-[11px] text-muted-foreground">{t("saving")}</span> : null}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => void copyLink()}>
            <Link2 className="size-3.5" />
            {t("copyLink")}
          </Button>
          {canWork ? (
            <Button variant="ghost" size="sm" onClick={() => void detail.toggleWatch()} aria-pressed={detail.watching}>
              {detail.watching ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {detail.watching ? t("unwatch") : t("watch")}
            </Button>
          ) : null}
          {variant === "modal" || canDelete ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t("moreActions")}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48 border-border bg-popover">
                {variant === "modal" ? (
                  <DropdownMenuItem render={<Link href={`/tickets/${ticket.id}`} />}>
                    <Pencil className="size-4" />
                    {t("openFullPage")}
                  </DropdownMenuItem>
                ) : null}
                {canDelete ? (
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                    <Trash2 className="size-4" />
                    {t("deleteTicket")}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-6">
            <InlineSummary
              key={`${ticket.id}:${ticket.subject}`}
              value={ticket.subject}
              disabled={!canWork}
              onSave={(subject) => void detail.update({ subject })}
            />
            <DescriptionSection
              key={`${ticket.id}:desc`}
              value={ticket.description ?? ""}
              disabled={!canWork}
              onSave={(description) => void detail.update({ description: description.trim() ? description : null })}
            />
            <TicketAttachmentsSection
              attachments={detail.attachments}
              uploading={detail.uploading}
              canWork={canWork}
              canRemove={canRemoveAttachment}
              onAddFiles={(files) => void detail.addFiles(files)}
              onRemove={(a) => void detail.removeAttachment(a)}
            />
            <TicketJiraSection ticketId={ticket.id} jira={jira} />
            <TicketLinksSection
              ticketId={ticket.id}
              links={detail.links}
              linked={detail.linked}
              keyOf={keyOf}
              canWork={canWork}
              onAdd={detail.addLink}
              onRemove={(id) => void detail.removeLink(id)}
              onOpenTicket={onOpenTicket}
            />
            <CustomFieldsSection
              key={ticket.id}
              ticket={ticket}
              defs={fieldDefs}
              disabled={!canWork}
              onSave={(next) => detail.update({ custom_fields: next })}
            />
            <TicketActivitySection
              comments={detail.comments}
              activity={detail.activity}
              members={members}
              teams={teams}
              fieldDefs={fieldDefs}
              linked={detail.linked}
              keyOf={keyOf}
              canWork={canWork}
              currentUserId={user?.id ?? null}
              onAddComment={detail.addComment}
              onEditComment={detail.editComment}
              onDeleteComment={detail.deleteComment}
              canShareToJira={canShareJira}
              jiraSharedNoteIds={jira.sharedNoteIds}
              onShareToJira={shareNoteToJira}
            />
          </div>

          <aside className="min-w-0">
            <TicketDetailsCard
              ticket={ticket}
              contact={detail.contact}
              members={members}
              teams={teams}
              watchers={detail.watchers}
              watching={detail.watching}
              knownLabels={knownLabels}
              canWork={canWork}
              currentUserId={user?.id ?? null}
              onUpdate={(patch) => void detail.update(patch)}
              onToggleWatch={() => void detail.toggleWatch()}
              onViewContact={() => setContactOpen(true)}
            />
          </aside>
        </div>
      </div>

      <ContactDetailView
        open={contactOpen}
        onOpenChange={setContactOpen}
        contactId={detail.contact?.id ?? null}
        onUpdated={() => {}}
      />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("deleteTitle", { key })}</DialogTitle>
            <DialogDescription>{t("deleteDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true);
                const ok = await detail.deleteTicket();
                setDeleting(false);
                if (ok) {
                  setConfirmDelete(false);
                  toast.success(t("deleted", { key }));
                }
              }}
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
