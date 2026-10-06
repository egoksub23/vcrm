"use client";

// ============================================================
// Doc Sign forms: extend the expiry of a document that is still open. A day later than the current expiry; the
// server checks again (sign.send, the document still open, later than now).
// ============================================================

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { fromDateInput } from "@/lib/sign/client/draft-options";
import { extendMinDate, extendProblem, progressErrorKey, suggestedExpiryDate } from "@/lib/sign/client/progress-logic";
import type { ExtendExpiryResult } from "@/lib/sign/forms/api-types";

interface Props {
  documentId: string;
  /** The current expiry (an ISO time), or null when there is none. */
  currentExpiry: string | null;
  now: Date;
  onClose: () => void;
  /** Called after the server accepted the new expiry (read the document again). */
  onExtended: () => void | Promise<void>;
}

export function ExtendExpiryDialog({ documentId, currentExpiry, now, onClose, onExtended }: Props) {
  const t = useTranslations("Sign.progress");
  const f = useFormatter();
  const [date, setDate] = useState(() => suggestedExpiryDate(currentExpiry, now));
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const problem = extendProblem(date, currentExpiry, now);

  async function submit() {
    setTried(true);
    const iso = fromDateInput(date);
    if (problem || !iso) return;
    setBusy(true);
    setErrorCode(null);
    try {
      await signRequest<ExtendExpiryResult>(`/api/sign/documents/${documentId}/expiry`, { json: { expiresAt: iso } });
      toast.success(t("expiry.done", { date: f.dateTime(new Date(iso), { dateStyle: "long" }) }));
      onClose();
      await onExtended();
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("expiry.title")}</DialogTitle>
            <DialogDescription>{currentExpiry ? t("expiry.current", { date: f.dateTime(new Date(currentExpiry), { dateStyle: "long", timeStyle: "short" }) }) : t("expiry.noCurrent")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="sign-extend-expiry">{t("expiry.newDate")}</Label>
            <Input
              id="sign-extend-expiry"
              type="date"
              min={extendMinDate(currentExpiry, now)}
              value={date}
              className="w-44"
              aria-invalid={tried && problem !== null}
              aria-describedby={tried && problem ? "sign-extend-expiry-err" : "sign-extend-expiry-note"}
              onChange={(e) => setDate(e.target.value)}
            />
            {tried && problem ? (
              <p id="sign-extend-expiry-err" className="text-xs text-destructive">
                {t(`expiry.problems.${problem}`)}
              </p>
            ) : (
              <p id="sign-extend-expiry-note" className="text-xs text-muted-foreground">
                {t("expiry.note")}
              </p>
            )}
          </div>
          {errorCode && (
            <p role="alert" className="text-sm text-destructive">
              {t(progressErrorKey(errorCode))}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t("expiry.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {t("expiry.action")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
