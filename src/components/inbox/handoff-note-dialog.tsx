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

interface HandoffNoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display name of the agent being assigned to. */
  agentName: string;
  onConfirm: (note: string) => void;
  busy: boolean;
}

/**
 * Shown when reassigning a conversation to a different human agent.
 * The note is optional — "Assign" works with an empty textarea, same
 * as clicking a name did before this existed — but the friction of
 * one extra click buys the new owner context instead of a cold open.
 */
export function HandoffNoteDialog({
  open,
  onOpenChange,
  agentName,
  onConfirm,
  busy,
}: HandoffNoteDialogProps) {
  const t = useTranslations("Inbox.handoff");
  const [note, setNote] = useState("");

  // Reset the draft each time the dialog transitions closed → open —
  // otherwise a note typed for one reassignment could leak into the next.
  // Adjusting state during render (React's documented pattern for this)
  // rather than in an effect avoids an extra cascading render.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setNote("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t("title", { name: agentName })}
          </DialogTitle>
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
          <Button onClick={() => onConfirm(note)} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t("assigning")}
              </>
            ) : (
              t("assign")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
