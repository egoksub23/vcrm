"use client";

// ============================================================
// Doc Sign, signing page: "I do not want to sign". A dialog with an optional reason and a plain statement
// of what happens, so it is never done by accident.
// ============================================================

import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

import { FieldError } from "./sheet-parts";

interface DeclineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A form without a signature (migration 169): the words say "complete", not "sign". */
  formOnly?: boolean;
  /** Migration 171: this is an envelope of that many documents; declining ends every one that is not yet fully signed, and the words say so. */
  envelopeCount?: number;
  /** Decline with the reason (may be empty). Resolves to the words of what went wrong, or null when it worked. */
  onConfirm: (reason: string) => Promise<string | null>;
}

export function DeclineDialog({ open, onOpenChange, onConfirm, formOnly, envelopeCount }: DeclineDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="motion-reduce:animate-none motion-reduce:duration-0 sm:max-w-md">
        {open ? <DeclineForm onCancel={() => onOpenChange(false)} onConfirm={onConfirm} formOnly={formOnly} envelopeCount={envelopeCount} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function DeclineForm({ onCancel, onConfirm, formOnly, envelopeCount }: { onCancel: () => void; onConfirm: (reason: string) => Promise<string | null>; formOnly?: boolean; envelopeCount?: number }) {
  const t = useTranslations("Sign.signer");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const errorId = useId();

  async function confirm() {
    setBusy(true);
    setError(null);
    const problem = await onConfirm(reason.trim());
    // on success the page changes and this dialog goes with it
    setBusy(false);
    if (problem) setError(problem);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-lg leading-snug">{formOnly ? t("decline.titleForm") : t("decline.title")}</DialogTitle>
        <DialogDescription>{formOnly ? t("decline.bodyForm") : t("decline.body")}</DialogDescription>
        {envelopeCount ? <p className="text-sm font-medium">{t("envelope.declineNote", { count: envelopeCount })}</p> : null}
      </DialogHeader>
      <div className="space-y-2">
        <label htmlFor={reasonId} className="block text-sm font-medium">
          {t("decline.reasonLabel")}
        </label>
        <Textarea
          id={reasonId}
          value={reason}
          maxLength={1000}
          rows={3}
          className="min-h-24 text-base"
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t("decline.reasonHelp")}</p>
        {error ? <FieldError id={errorId}>{error}</FieldError> : null}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" className="h-11 text-base" onClick={onCancel} disabled={busy}>
          {t("decline.keep")}
        </Button>
        <Button type="button" className="h-11 bg-red-700 text-base text-white hover:bg-red-800 focus-visible:ring-red-500/50" onClick={() => void confirm()} disabled={busy}>
          {busy ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
          {formOnly ? t("decline.confirmForm") : t("decline.confirm")}
        </Button>
      </div>
    </>
  );
}
