"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FileText, Loader2, Paperclip, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmojiTextarea } from "@/components/emoji/emoji-textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import { useAccountMembers } from "@/hooks/use-account-members";
import { useAuth } from "@/hooks/use-auth";
import { useTeams } from "@/hooks/use-teams";
import { useTicketFields } from "@/hooks/use-ticket-fields";
import { useTicketKeyPrefix } from "@/hooks/use-ticket-key-prefix";
import { useTicketLabels } from "@/hooks/use-ticket-labels";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { dragHasFiles, pastedImages } from "@/lib/media/clipboard-images";
import { attachFileToTicket } from "@/lib/tickets/attachment-actions";
import {
  TICKET_MAX_ATTACHMENTS,
  checkTicketFile,
  formatBytes,
  isImageMime,
} from "@/lib/tickets/attachments";
import { TICKET_CATEGORIES, TICKET_PRIORITIES } from "@/lib/tickets/constants";
import {
  fieldsForCategory,
  missingRequiredFields,
  sanitizeCustomValues,
} from "@/lib/tickets/custom-fields";
import { TicketFieldInput } from "./ticket-field-input";
import { TicketLabelPicker } from "./ticket-label-picker";
import { PriorityIcon, TypeIcon } from "./ticket-visuals";
import type {
  Contact,
  Ticket,
  TicketCategory,
  TicketCustomValues,
  TicketPriority,
} from "@/types";

const NONE = "__none__";

interface StagedFile {
  key: string;
  file: File;
  /** Local preview for pictures; revoked when removed / after creating. */
  preview: string | null;
}

interface CreateTicketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-set when opened from a Contact profile or a conversation
   *  thread. Left unset when opened from the standalone /tickets page,
   *  which shows a contact search field instead. */
  contactId?: string;
  /** Set when raised from an open chat (message-thread's "Raise Ticket"
   *  button) — links the ticket back to the conversation it came from.
   *  Left unset for the "+ New Ticket" entry point on the Contact
   *  profile, matching klink.cloud's own flow. */
  conversationId?: string | null;
  onCreated?: (ticket: Ticket) => void;
  /** The "Open" button on the created toast. Without it the button goes to
   *  /tickets?t=<id>. */
  onOpenCreated?: (ticketId: string) => void;
}

/**
 * Raise-a-ticket form in Jira's "Create issue" order: type, customer,
 * summary, description, assignee, team, priority, labels, due date,
 * attachments, then the account's custom fields (migration 066). Opened from
 * the Tickets page, a Contact profile or an open conversation (the last two
 * arrive with the customer / chat filled in). Ticket numbering is a
 * per-account atomic counter (next_ticket_number RPC, migration 063) so two
 * agents creating tickets at once never collide. "Create another" keeps the
 * dialog open with the person and the routing fields kept.
 */
export function CreateTicketDialog({
  open,
  onOpenChange,
  contactId,
  conversationId,
  onCreated,
  onOpenCreated,
}: CreateTicketDialogProps) {
  const t = useTranslations("Tickets.create");
  const tCommon = useTranslations("Tickets.common");
  const router = useRouter();
  const { user, accountId } = useAuth();
  const { members } = useAccountMembers();
  const { teams } = useTeams();
  const { prefix } = useTicketKeyPrefix();
  const { labels: knownLabels } = useTicketLabels(open);

  const [category, setCategory] = useState<TicketCategory>("general");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [labels, setLabels] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState("");
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [another, setAnother] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);

  // Admin-defined form fields (migration 066). Only fetched while the
  // dialog is open; the visible set follows the selected type.
  const { fields: fieldDefs } = useTicketFields(open);
  const [customValues, setCustomValues] = useState<TicketCustomValues>({});
  const [showInvalid, setShowInvalid] = useState(false);
  const visibleFields = fieldsForCategory(fieldDefs, category);
  const missingIds = new Set(missingRequiredFields(fieldDefs, category, customValues));

  // Contact picker — only shown when the caller didn't already know
  // which contact this ticket is for (the standalone /tickets page's
  // "New Ticket" button).
  const needsContactPicker = !contactId;
  const [contactQuery, setContactQuery] = useState("");
  const [contactMatches, setContactMatches] = useState<Contact[]>([]);
  const [pickedContact, setPickedContact] = useState<Contact | null>(null);
  const [searchingContacts, setSearchingContacts] = useState(false);

  useEffect(() => {
    if (!needsContactPicker || !contactQuery.trim() || !accountId) {
      setContactMatches([]);
      return;
    }
    let cancelled = false;
    setSearchingContacts(true);
    const supabase = createClient();
    // Characters that would break the PostgREST filter list are dropped.
    const q = contactQuery.replace(/[,()%*\\]/g, " ").trim();
    const handle = setTimeout(() => {
      supabase
        .from("contacts")
        .select("*")
        .or(`name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`)
        .limit(8)
        .then(({ data }) => {
          if (cancelled) return;
          setContactMatches((data as Contact[]) ?? []);
          setSearchingContacts(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [needsContactPicker, contactQuery, accountId]);

  const clearStaged = () => {
    for (const s of staged) if (s.preview) URL.revokeObjectURL(s.preview);
    setStaged([]);
  };

  /** Back to a blank form (what "Create another" keeps is handled by the caller). */
  const reset = () => {
    setCategory("general");
    setSubject("");
    setDescription("");
    setAssignee(null);
    setTeamId(null);
    setPriority("normal");
    setLabels([]);
    setDueDate("");
    setCustomValues({});
    setShowInvalid(false);
    setAnother(false);
    setContactQuery("");
    setContactMatches([]);
    setPickedContact(null);
    clearStaged();
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const addFiles = (files: File[]) => {
    let count = staged.length;
    const next: StagedFile[] = [];
    for (const file of files) {
      const rejection = checkTicketFile(file, count);
      if (rejection) {
        toast.error(
          rejection.reason === "tooMany"
            ? t("tooManyFiles", { max: TICKET_MAX_ATTACHMENTS })
            : t("fileTooLarge", { name: file.name, max: formatBytes(rejection.maxBytes) }),
        );
        if (rejection.reason === "tooMany") break;
        continue;
      }
      count += 1;
      next.push({
        key: `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        preview: isImageMime(file.type) ? URL.createObjectURL(file) : null,
      });
    }
    if (next.length) setStaged((prev) => [...prev, ...next]);
  };

  const removeStaged = (key: string) =>
    setStaged((prev) => {
      const gone = prev.find((s) => s.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((s) => s.key !== key);
    });

  const handleSubmit = async () => {
    const trimmedSubject = subject.trim();
    if (!trimmedSubject) {
      toast.error(t("summaryRequired"));
      return;
    }

    const resolvedContactId = contactId || pickedContact?.id;
    if (!resolvedContactId) {
      toast.error(t("contactRequired"));
      return;
    }

    if (!user || !accountId) {
      toast.error(t("createFailed"));
      return;
    }

    if (missingIds.size > 0) {
      setShowInvalid(true);
      toast.error(t("requiredFieldsMissing"));
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();
      const { data: ticketNumber, error: seqError } = await supabase.rpc(
        "next_ticket_number",
        { p_account_id: accountId },
      );
      if (seqError || ticketNumber == null) {
        toast.error(t("createFailed"));
        return;
      }

      const { data: inserted, error: insertError } = await supabase
        .from("tickets")
        .insert({
          account_id: accountId,
          ticket_number: ticketNumber,
          contact_id: resolvedContactId,
          conversation_id: conversationId ?? null,
          subject: trimmedSubject,
          description: description.trim() || null,
          category,
          priority,
          assigned_agent_id: assignee,
          assigned_team_id: teamId,
          labels,
          due_date: dueDate || null,
          custom_fields: sanitizeCustomValues(fieldDefs, category, customValues),
          created_by: user.id,
        })
        .select("*")
        .single();

      if (insertError || !inserted) {
        toast.error(t("createFailed"));
        return;
      }
      const ticket = inserted as Ticket;

      // Files go up after the ticket exists (they are filed under it). A
      // failed file does not undo the ticket.
      let failed = 0;
      for (const s of staged) {
        try {
          await attachFileToTicket(ticket, s.file, user.id);
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) toast.error(t("attachmentsFailed", { count: failed }));

      const key = `${prefix}-${ticketNumber}`;
      toast.success(t("created", { key }), {
        action: {
          label: t("open"),
          onClick: () => (onOpenCreated ? onOpenCreated(ticket.id) : router.push(`/tickets?t=${ticket.id}`)),
        },
      });
      onCreated?.(ticket);

      if (another) {
        // Keep who it is for and how it is routed; clear what is about this one.
        setSubject("");
        setDescription("");
        setLabels([]);
        setDueDate("");
        setCustomValues({});
        setShowInvalid(false);
        clearStaged();
        requestAnimationFrame(() => subjectRef.current?.focus());
      } else {
        handleOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto border-border bg-popover text-popover-foreground sm:max-w-2xl"
        onPaste={(e) => {
          // A picture pasted anywhere in the form is staged as an attachment.
          const images = pastedImages(e.clipboardData?.files, e.clipboardData?.getData("text/plain"));
          if (images.length === 0) return;
          e.preventDefault();
          addFiles(images);
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("title")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-foreground">{t("typeLabel")}</Label>
            <Select value={category} onValueChange={(v) => setCategory((v ?? "general") as TicketCategory)}>
              <SelectTrigger className="w-full bg-muted sm:w-64">
                <SelectValue>
                  <TypeIcon category={category} withLabel />
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TICKET_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    <TypeIcon category={c} withLabel />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {needsContactPicker && (
            <div className="space-y-1.5">
              <Label htmlFor="ticket-contact" className="text-foreground">
                {t("contactLabel")}
              </Label>
              {pickedContact ? (
                <div className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                  <span className="text-foreground">{pickedContact.name || contactHandle(pickedContact)}</span>
                  <button
                    type="button"
                    onClick={() => setPickedContact(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t("change")}
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <Input
                    id="ticket-contact"
                    value={contactQuery}
                    onChange={(e) => setContactQuery(e.target.value)}
                    placeholder={t("contactPlaceholder")}
                    disabled={busy}
                  />
                  {contactQuery.trim() && (
                    <div className="absolute z-10 mt-1 w-full rounded-lg border border-border bg-popover shadow-md">
                      {searchingContacts ? (
                        <div className="flex items-center justify-center py-3">
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        </div>
                      ) : contactMatches.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-muted-foreground">{t("noContacts")}</p>
                      ) : (
                        contactMatches.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              setPickedContact(c);
                              setContactQuery("");
                            }}
                            className="flex w-full flex-col items-start px-3 py-1.5 text-left text-sm hover:bg-muted"
                          >
                            <span className="text-foreground">{c.name || contactHandle(c)}</span>
                            {c.name && <span className="text-xs text-muted-foreground">{contactHandle(c)}</span>}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ticket-subject" className="text-foreground">
              {t("summaryLabel")} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ticket-subject"
              ref={subjectRef}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("summaryPlaceholder")}
              disabled={busy}
              maxLength={200}
              autoFocus={!needsContactPicker}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ticket-description" className="text-foreground">
              {t("descriptionLabel")}
            </Label>
            <EmojiTextarea
              id="ticket-description"
              value={description}
              onValueChange={setDescription}
              placeholder={t("descriptionPlaceholder")}
              rows={4}
              disabled={busy}
              className="w-full resize-y rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50 disabled:opacity-60"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-foreground">{t("assigneeLabel")}</Label>
                {user && assignee !== user.id ? (
                  <button
                    type="button"
                    onClick={() => setAssignee(user.id)}
                    className="text-xs text-primary hover:underline"
                  >
                    {t("assignToMe")}
                  </button>
                ) : null}
              </div>
              <Select value={assignee ?? NONE} onValueChange={(v) => setAssignee(!v || v === NONE ? null : v)}>
                <SelectTrigger className="w-full bg-muted">
                  <SelectValue>
                    {assignee ? (members.find((m) => m.user_id === assignee)?.full_name ?? tCommon("unknownPerson")) : tCommon("unassigned")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{tCommon("unassigned")}</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {teams.length > 0 ? (
              <div className="space-y-1.5">
                <Label className="text-foreground">{t("teamLabel")}</Label>
                <Select value={teamId ?? NONE} onValueChange={(v) => setTeamId(!v || v === NONE ? null : v)}>
                  <SelectTrigger className="w-full bg-muted">
                    <SelectValue>{teams.find((tm) => tm.id === teamId)?.name ?? tCommon("noTeam")}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{tCommon("noTeam")}</SelectItem>
                    {teams.map((tm) => (
                      <SelectItem key={tm.id} value={tm.id}>
                        {tm.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label className="text-foreground">{t("priorityLabel")}</Label>
              <Select value={priority} onValueChange={(v) => setPriority((v ?? "normal") as TicketPriority)}>
                <SelectTrigger className="w-full bg-muted">
                  <SelectValue>
                    <PriorityIcon priority={priority} withLabel />
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TICKET_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      <PriorityIcon priority={p} withLabel />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ticket-due" className="text-foreground">
                {t("dueDateLabel")}
              </Label>
              <Input
                id="ticket-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                disabled={busy}
                className="dark:scheme-dark"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-foreground">{t("labelsLabel")}</Label>
            <TicketLabelPicker labels={labels} known={knownLabels} onChange={setLabels} disabled={busy} />
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-foreground">
              <Paperclip className="size-3.5 text-muted-foreground" />
              {t("attachmentsLabel")}
            </Label>
            <div
              onDragOver={(e) => {
                if (!dragHasFiles(e.dataTransfer.types)) return;
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                if (!dragHasFiles(e.dataTransfer.types)) return;
                e.preventDefault();
                setDragging(false);
                addFiles(Array.from(e.dataTransfer.files));
              }}
              className={`rounded-lg border border-dashed px-3 py-3 text-center text-xs text-muted-foreground transition-colors ${
                dragging ? "border-primary bg-primary/5" : "border-border"
              }`}
            >
              <button
                type="button"
                disabled={busy || staged.length >= TICKET_MAX_ATTACHMENTS}
                onClick={() => fileInput.current?.click()}
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60"
              >
                <Upload className="size-3.5" />
                {t("addFiles")}
              </button>{" "}
              {t("attachmentsHint")}
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </div>
            {staged.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {staged.map((s) => (
                  <li
                    key={s.key}
                    className="flex max-w-full items-center gap-2 rounded-md border border-border bg-muted/50 py-1 pr-1.5 pl-1 text-xs"
                  >
                    {s.preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.preview} alt="" className="size-8 rounded object-cover" />
                    ) : (
                      <FileText className="mx-1.5 size-4 text-muted-foreground" />
                    )}
                    <span className="max-w-40 truncate">{s.file.name || t("pastedImage")}</span>
                    <span className="text-muted-foreground">{formatBytes(s.file.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeStaged(s.key)}
                      disabled={busy}
                      aria-label={t("removeFile", { name: s.file.name })}
                      className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {visibleFields.map((field) => (
            <TicketFieldInput
              key={field.id}
              field={field}
              value={customValues[field.id]}
              onChange={(v) =>
                setCustomValues((prev) => {
                  const next = { ...prev };
                  if (v === undefined) delete next[field.id];
                  else next[field.id] = v;
                  return next;
                })
              }
              disabled={busy}
              invalid={showInvalid && missingIds.has(field.id)}
              idPrefix="create-ticket-field"
            />
          ))}
        </div>

        <DialogFooter className="items-center border-border bg-popover">
          <label className="mr-auto flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked={another} onCheckedChange={(v) => setAnother(v === true)} disabled={busy} />
            {t("createAnother")}
          </label>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={busy}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
