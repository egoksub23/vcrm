"use client";

// ============================================================
// Secure Sign: cancel a COMPLETED document, or a whole document collection (migration 181). One dialog for the list's row menu and for the detail
// pages. It says what cancelling does (the signed copy and certificate stay as a record; the document is marked cancelled and cannot be reactivated;
// for a collection, every document in it goes with it), asks for the reason (required, 3 to 500 characters, with a counter), and offers "Notify everyone"
// (off) with how many people would be emailed. The server decides who may cancel; this only asks.
//
// Accessible: the dialog is labelled by its title and described by its body (the dialog primitive traps focus and closes on Escape), the reason has a
// real label and its problem is announced, the tick box is a real label, and nothing is lost on a 360 px screen (the footer stacks).
// ============================================================

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { CANCEL_REASON_MAX, CANCEL_REASON_MIN, cancelReasonProblem, characterCount, cleanCancelReason, type CancelResult } from "@/lib/sign/cancel";

import { detailErrorKey } from "./logic";

/** What is being cancelled: a document on its own, or a collection (with how many documents go with it). */
export type CancelTarget = { kind: "document"; id: string } | { kind: "collection"; id: string; documents: number };

/** How many people the notice would go to (the sender is always one more). */
export interface CancelAudience {
  signers: number;
  copies: number;
}

interface Props {
  target: CancelTarget;
  /** The document's (or collection's) title, shown so the person is sure which one this is. */
  title: string;
  /** The people the notice would reach, when the page already knows; otherwise the dialog reads them. */
  audience?: CancelAudience;
  onClose: () => void;
  /** Called after it was cancelled (the screen reads its data again). */
  onCancelled: (result: CancelResult) => Promise<void> | void;
}

interface PeopleRows {
  signers?: readonly { id: string; party_id?: string | null; part_keys?: string[] | null }[];
  copies?: readonly unknown[];
}

/** Count the people from what the document's or collection's route returns: each signer once (a person of a collection once, whatever the number of documents), never a person handed only a part. */
export function audienceOf(body: PeopleRows): CancelAudience {
  const people = new Set((body.signers ?? []).filter((s) => !(s.part_keys && s.part_keys.length > 0)).map((s) => s.party_id ?? s.id));
  return { signers: people.size, copies: (body.copies ?? []).length };
}

/** The dialog: the body below, in the dialog frame. It cannot be dismissed while the request is in flight. */
export function CancelDialog(props: Props) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogContent>
        <CancelBody {...props} busy={busy} setBusy={setBusy} />
      </DialogContent>
    </Dialog>
  );
}

/** What is inside the dialog (apart from the frame, so it can be rendered on its own in a test). */
export function CancelBody({ target, title, audience: given, onClose, onCancelled, busy, setBusy }: Props & { busy: boolean; setBusy: (busy: boolean) => void }) {
  const t = useTranslations("Sign.detail");
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [read, setRead] = useState<CancelAudience | null>(null);
  const audience = given ?? read;
  const collection = target.kind === "collection";

  // the people the notice would go to, when the screen did not bring them (the list's row menu)
  useEffect(() => {
    if (given) return;
    let alive = true;
    signRequest<PeopleRows>(collection ? `/api/sign/envelopes/${target.id}` : `/api/sign/documents/${target.id}`)
      .then((body) => alive && setRead(audienceOf(body)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [given, collection, target.id]);

  const trimmed = cleanCancelReason(reason);
  const problem = cancelReasonProblem(trimmed);
  const showProblem = tried && problem !== null;
  const count = characterCount(reason);

  async function submit() {
    setTried(true);
    if (problem !== null) return;
    setBusy(true);
    setErrorCode(null);
    try {
      const result = await signRequest<CancelResult>(collection ? `/api/sign/envelopes/${target.id}/cancel` : `/api/sign/documents/${target.id}/cancel`, { json: { reason: trimmed, notify } });
      toast.success(collection ? t("cancel.doneCollection", { count: result.documents }) : t("cancel.done"));
      if (result.notice && result.notice.failed > 0) toast.warning(t("cancel.noticeSome", { failed: result.notice.failed }));
      onClose();
      await onCancelled(result);
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
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
        <DialogTitle>{t("cancel.title")}</DialogTitle>
        <DialogDescription>{collection ? t("cancel.bodyCollection") : t("cancel.body")}</DialogDescription>
      </DialogHeader>
      <p className="break-words text-sm font-medium text-foreground">{title}</p>
      {collection ? (
        <p role="note" className="rounded-lg border border-[color:light-dark(#fca5a5,#7f1d1d)] bg-[color:light-dark(#fef2f2,#450a0a66)] p-3 text-sm font-medium text-[light-dark(#991b1b,#fca5a5)]">
          {t("cancel.collectionWarning", { count: target.documents })}
        </p>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor="sign-cancel-reason">{t("cancel.reason")}</Label>
        <Textarea
          id="sign-cancel-reason"
          value={reason}
          maxLength={CANCEL_REASON_MAX}
          rows={3}
          aria-invalid={showProblem}
          aria-describedby={showProblem ? "sign-cancel-reason-err sign-cancel-reason-count" : "sign-cancel-reason-hint sign-cancel-reason-count"}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex items-start justify-between gap-3 text-xs">
          {showProblem ? (
            <p id="sign-cancel-reason-err" role="alert" className="text-destructive">
              {t(problem === "short" ? "cancel.reasonShort" : "cancel.reasonRequired", { min: CANCEL_REASON_MIN })}
            </p>
          ) : (
            <p id="sign-cancel-reason-hint" className="text-muted-foreground">
              {t("cancel.reasonHint")}
            </p>
          )}
          <p id="sign-cancel-reason-count" className="shrink-0 tabular-nums text-muted-foreground">
            {t("cancel.counter", { count, max: CANCEL_REASON_MAX })}
          </p>
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox className="mt-0.5" checked={notify} disabled={busy} onCheckedChange={(on) => setNotify(on === true)} aria-labelledby="sign-cancel-notify-label" aria-describedby="sign-cancel-notify-who" />
        <span className="grid gap-0.5">
          <span id="sign-cancel-notify-label" className="text-sm font-medium text-foreground">
            {t("cancel.notify")}
          </span>
          <span id="sign-cancel-notify-who" className="text-xs text-muted-foreground">
            {audience ? t("cancel.notifyWho", { signers: audience.signers, copies: audience.copies }) : t("cancel.notifyWhoPlain")} {t("cancel.notifyNote")}
          </span>
        </span>
      </label>

      {errorCode && (
        <p role="alert" className="text-sm text-destructive">
          {t(detailErrorKey(errorCode))}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          {t("cancel.keep")}
        </Button>
        <Button type="submit" variant="destructive" disabled={busy}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {t("cancel.action")}
        </Button>
      </DialogFooter>
    </form>
  );
}
