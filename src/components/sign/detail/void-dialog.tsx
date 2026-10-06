"use client";

// Doc Sign, the detail screen: cancel a document that was sent. A reason is required; it is kept in the history
// and the people who were waiting are told.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SignApiError, signRequest } from "@/lib/sign/client/api";

import { detailErrorKey } from "./logic";

interface Props {
  documentId: string;
  title: string;
  onClose: () => void;
  /** Called after the document was cancelled. */
  onVoided: () => Promise<void>;
}

export function VoidDialog({ documentId, title, onClose, onVoided }: Props) {
  const t = useTranslations("Sign.detail");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const missing = tried && reason.trim() === "";

  async function submit() {
    setTried(true);
    if (reason.trim() === "") return;
    setBusy(true);
    setErrorCode(null);
    try {
      await signRequest(`/api/sign/documents/${documentId}/void`, { json: { reason: reason.trim() } });
      toast.success(t("void.done"));
      onClose();
      await onVoided();
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
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
            <DialogTitle>{t("void.title", { title })}</DialogTitle>
            <DialogDescription>{t("void.body")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="sign-void-reason">{t("void.reason")}</Label>
            <Textarea id="sign-void-reason" value={reason} maxLength={1000} rows={3} aria-invalid={missing} aria-describedby={missing ? "sign-void-reason-err" : undefined} onChange={(e) => setReason(e.target.value)} />
            {missing && (
              <p id="sign-void-reason-err" className="text-xs text-destructive">
                {t("void.reasonRequired")}
              </p>
            )}
          </div>
          {errorCode && (
            <p role="alert" className="text-sm text-destructive">
              {t(detailErrorKey(errorCode))}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t("void.keep")}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {t("void.action")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
