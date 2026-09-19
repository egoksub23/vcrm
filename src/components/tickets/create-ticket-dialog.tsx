"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { useAuth } from "@/hooks/use-auth";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { useTicketFields } from "@/hooks/use-ticket-fields";
import {
  fieldsForCategory,
  missingRequiredFields,
  sanitizeCustomValues,
} from "@/lib/tickets/custom-fields";
import { TicketFieldInput } from "./ticket-field-input";
import type {
  Contact,
  Ticket,
  TicketCategory,
  TicketCustomValues,
  TicketPriority,
} from "@/types";

const CATEGORIES: TicketCategory[] = [
  "general",
  "billing",
  "technical",
  "feature_request",
  "bug",
  "account",
  "other",
];

const PRIORITIES: TicketPriority[] = ["urgent", "high", "normal", "low"];

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
}

/**
 * Raise-a-ticket form, opened either from a Contact profile ("+ New
 * Ticket", the klink.cloud pattern) or from an open conversation's
 * thread header ("Raise Ticket"). Ticket numbering is a per-account
 * atomic counter (next_ticket_number RPC, migration 063) so two agents
 * creating tickets at once never collide.
 */
export function CreateTicketDialog({
  open,
  onOpenChange,
  contactId,
  conversationId,
  onCreated,
}: CreateTicketDialogProps) {
  const t = useTranslations("Tickets.create");
  const { user, accountId } = useAuth();
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<TicketCategory>("general");
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [busy, setBusy] = useState(false);

  // Admin-defined form fields (migration 066). Only fetched while the
  // dialog is open; the visible set follows the selected category.
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
    const handle = setTimeout(() => {
      supabase
        .from("contacts")
        .select("*")
        .or(`name.ilike.%${contactQuery}%,phone.ilike.%${contactQuery}%,email.ilike.%${contactQuery}%`)
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

  const reset = () => {
    setSubject("");
    setDescription("");
    setCategory("general");
    setPriority("normal");
    setCustomValues({});
    setShowInvalid(false);
    setContactQuery("");
    setContactMatches([]);
    setPickedContact(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    const trimmedSubject = subject.trim();
    if (!trimmedSubject) {
      toast.error(t("subjectRequired"));
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

      const { data: ticket, error: insertError } = await supabase
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
          custom_fields: sanitizeCustomValues(fieldDefs, category, customValues),
          created_by: user.id,
        })
        .select("*")
        .single();

      if (insertError || !ticket) {
        toast.error(t("createFailed"));
        return;
      }

      toast.success(t("created", { number: ticketNumber }));
      onCreated?.(ticket as Ticket);
      handleOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("title")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {needsContactPicker && (
            <div className="space-y-1.5">
              <Label htmlFor="ticket-contact" className="text-foreground">
                {t("contactLabel")}
              </Label>
              {pickedContact ? (
                <div className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 text-sm">
                  <span className="text-foreground">
                    {pickedContact.name || contactHandle(pickedContact)}
                  </span>
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
                            {c.name && (
                              <span className="text-xs text-muted-foreground">{contactHandle(c)}</span>
                            )}
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
              {t("subjectLabel")}
            </Label>
            <Input
              id="ticket-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("subjectPlaceholder")}
              disabled={busy}
              maxLength={200}
              autoFocus={!needsContactPicker}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ticket-description" className="text-foreground">
              {t("descriptionLabel")}
            </Label>
            <textarea
              id="ticket-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              rows={4}
              disabled={busy}
              className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50 disabled:opacity-60"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-foreground">{t("categoryLabel")}</Label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v as TicketCategory)}
              >
                <SelectTrigger className="w-full bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {t(`category.${c}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-foreground">{t("priorityLabel")}</Label>
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as TicketPriority)}
              >
                <SelectTrigger className="w-full bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {t(`priority.${p}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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

        <DialogFooter className="bg-popover border-border">
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
