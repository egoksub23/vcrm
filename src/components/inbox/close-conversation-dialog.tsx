"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

const NOTE_MAX_LEN = 1000;

interface CloseConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (note: string) => void;
  busy: boolean;
}

/**
 * Shown when closing a conversation — klink.cloud parity
 * (docs.klink.cloud/settings/dispositions-and-wrap-up): closing requires
 * a wrap-up note. Unlike HandoffNoteDialog's note, this one is required —
 * "Close" stays disabled until there's non-whitespace text — matching the
 * `conversation_events_close_requires_note` DB CHECK (migration 065) that
 * enforces the same rule server-side.
 */
export function CloseConversationDialog({
  open,
  onOpenChange,
  onConfirm,
  busy,
}: CloseConversationDialogProps) {
  const t = useTranslations("Inbox.closeDialog");
  const [note, setNote] = useState("");

  // Reset the draft each time the dialog transitions closed → open, same
  // pattern as HandoffNoteDialog.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setNote("");
  }

  const canConfirm = note.trim().length > 0 && !busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("title")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={NOTE_MAX_LEN}
          rows={4}
          placeholder={t("notePlaceholder")}
          disabled={busy}
          autoFocus
          className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50 disabled:opacity-60"
        />

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button onClick={() => onConfirm(note.trim())} disabled={!canConfirm}>
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t("closing")}
              </>
            ) : (
              t("close")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
