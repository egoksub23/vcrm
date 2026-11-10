"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/**
 * Closing an incident is the moment to say how it ended, so it asks for a closing note (what was done, and what happens next). The note is saved as a note of
 * kind "closing", shown in the Conclusions panel and printed first in the report for filing. A school can require one (Setup, Rules, "Before an incident
 * moves on"); until then it can be left empty. If a closing note is already written, saying so is enough.
 */
export function CloseDialog({
  open,
  onOpenChange,
  hasClosingNote,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasClosingNote: boolean;
  onConfirm: (note: string) => Promise<void>;
}) {
  const t = useTranslations("Incidents.detail.close");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Start empty each time it opens.
  const [seenOpen, setSeenOpen] = useState(false);
  if (open && !seenOpen) {
    setSeenOpen(true);
    setNote("");
  } else if (!open && seenOpen) {
    setSeenOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("help")}</DialogDescription>
        </DialogHeader>
        {hasClosingNote ? <p className="text-xs text-muted-foreground">{t("alreadyWritten")}</p> : null}
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={5000} placeholder={t("placeholder")} className="bg-muted text-[13px]" aria-label={t("note")} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onConfirm(note.trim());
              setBusy(false);
            }}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
