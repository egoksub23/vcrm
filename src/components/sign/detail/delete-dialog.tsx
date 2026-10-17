"use client";

// ============================================================
// Secure Sign: delete a signed document, or a whole document collection, once its retention date has passed. The server and the database ask again
// (needs sign.settings; the database refuses a signed document before its date for everyone), so this only asks the person to be sure. It says plainly
// what goes (the sealed PDF, the certificate, every signer's answers and uploads), that it cannot be undone, and shows which record it is.
// A clear destructive Delete button is the confirmation: no typing. On success it goes back to the list; on a refusal it shows the server's reason.
//
// Accessible: the dialog is labelled by its title and described by its body (the dialog primitive traps focus and closes on Escape), a refusal is
// announced, and it cannot be dismissed while the request is in flight.
// ============================================================

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SignApiError, signRequest } from "@/lib/sign/client/api";

import { formatDay } from "./format";
import { deleteRefusalReason } from "./logic";

/** What is being deleted: a document on its own, or a collection (with how many documents go with it). */
export type DeleteTarget = { kind: "document"; id: string } | { kind: "collection"; id: string; documents: number };

interface Props {
  target: DeleteTarget;
  /** COL-... or the document's reference (a record without one shows its title only). */
  reference: string | null;
  title: string;
  /** The date the record was kept until, shown as the reason it may go now. */
  retainUntil?: string | null;
  onClose: () => void;
}

/** The dialog: the body below, in the dialog frame. It cannot be dismissed while the request is in flight. */
export function DeleteSignedDialog(props: Props) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogContent>
        <DeleteBody {...props} busy={busy} setBusy={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

/** What is inside the dialog (apart from the frame, so it can be rendered on its own in a test). */
export function DeleteBody({ target, reference, title, retainUntil, onClose, busy, setBusy }: Props & { busy: boolean; setBusy: (busy: boolean) => void }) {
  const t = useTranslations("Sign.detail");
  const locale = useLocale();
  const router = useRouter();
  const [reason, setReason] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const collection = target.kind === "collection";

  async function submit() {
    setBusy(true);
    setReason(null);
    setFailed(false);
    try {
      await signRequest(collection ? `/api/sign/envelopes/${target.id}` : `/api/sign/documents/${target.id}`, { method: "DELETE" });
      toast.success(t("delete.done", { reference: reference ?? title }));
      // the record is gone: its page would only say "not found", so go back to the list
      router.push("/sign");
    } catch (err) {
      // the server's own reason when it refused (the date has not passed, no permission, it changed meanwhile); a sentence of ours when it was not a refusal
      const why = err instanceof SignApiError ? deleteRefusalReason(err) : null;
      setReason(why);
      setFailed(why === null);
      setBusy(false);
    }
  }

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t(collection ? "delete.titleCollection" : "delete.title")}</DialogTitle>
        <DialogDescription>{collection ? t("delete.bodyCollection", { count: target.documents }) : t("delete.body")}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-0.5">
        <p className="break-words text-sm font-medium text-foreground">{title}</p>
        {reference ? <p className="break-words text-sm text-muted-foreground">{t("delete.reference", { reference })}</p> : null}
        {retainUntil ? <p className="break-words text-sm text-muted-foreground">{t("delete.retentionEnded", { date: formatDay(retainUntil, locale) })}</p> : null}
      </div>
      <p role="note" className="rounded-lg border border-[color:light-dark(#fca5a5,#7f1d1d)] bg-[color:light-dark(#fef2f2,#450a0a66)] p-3 text-sm font-medium text-[light-dark(#991b1b,#fca5a5)]">
        {t("delete.warning")}
      </p>
      {reason || failed ? (
        <p role="alert" className="text-sm text-destructive">
          {reason ?? t("delete.failed")}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          {t("delete.keep")}
        </Button>
        <Button type="submit" variant="destructive" disabled={busy}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {t("delete.action")}
        </Button>
      </DialogFooter>
    </form>
  );
}
