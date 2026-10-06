"use client";

// ============================================================
// "Replace file" on a draft (F-77). Choose the new file (PDF, Word or an image); the server says what would happen (a dry run), this
// dialog lists it: how many pages, how many fields keep their place, and which are flagged and why. Nothing changes until the sender
// confirms. A document that was sent is never offered this (the button is only on a draft).
//
// The dialog's frame and what is inside it are two components (`ReplaceFileDialog`, `ReplaceFileBody`): the frame is a portal, so the
// render tests draw the body on its own, in every language. The body's state starts fresh each time the dialog opens.
// ============================================================

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, CircleCheck, Loader2 } from "lucide-react";

import { FileDrop } from "@/components/sign/send/file-drop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SignApiError } from "@/lib/sign/client/api";
import { errorKey } from "@/lib/sign/client/errors";
import { fieldName, postReplace, reasonKey, type ReplaceAnswer } from "@/lib/sign/client/replace-file";
import { checkUploadFile } from "@/lib/sign/client/upload";
import type { PlacedField } from "@/lib/sign/pdf/types";
import { groupFlagged } from "@/lib/sign/replace-file";

interface Props {
  documentId: string;
  /** The fields as they are on screen, to name the flagged ones. */
  fields: readonly PlacedField[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Send any waiting changes first, so the server decides on the fields as they are. Resolves false when they could not be saved. */
  beforeStart: () => Promise<boolean>;
  /** The file was replaced: reload the editor. */
  onReplaced: () => void;
}

export function ReplaceFileDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <ReplaceFileBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

/** What the sender is told about the new file: its pages, and which fields keep their place and which are flagged. */
export function PlanSummary({ plan, fields }: { plan: ReplaceAnswer; fields: readonly PlacedField[] }) {
  const t = useTranslations("Sign.editor");
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const nameOf = (key: string) => fieldName(byKey.get(key), (type) => t(`types.${type}`), t("replaceFile.unknownField"));
  return (
    <div className="space-y-3 text-sm" aria-live="polite">
      <p className="text-foreground">{t("replaceFile.pages", { old: plan.oldPageCount, next: plan.newPageCount })}</p>
      {plan.pageCountChanged ? <p className="text-muted-foreground">{t("replaceFile.pagesChanged")}</p> : null}
      {plan.converted ? <p className="text-muted-foreground">{t("replaceFile.converted")}</p> : null}
      {plan.flagged.length === 0 ? (
        <p className="flex items-start gap-2 text-foreground">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
          {fields.length === 0 ? t("replaceFile.noFields") : t("replaceFile.allKept", { count: plan.kept })}
        </p>
      ) : (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
          <p className="flex items-start gap-2 font-medium text-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
            {t("replaceFile.flaggedTitle", { flagged: plan.flagged.length, kept: plan.kept })}
          </p>
          {groupFlagged(plan.flagged).map((g) => (
            <div key={g.reason}>
              <p className="text-xs font-medium text-muted-foreground">{t(`replaceFile.${reasonKey(g.reason)}`)}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {g.fields.map((f) => (
                  <li key={f.key}>{f.movedTo !== undefined ? t("replaceFile.movedLine", { name: nameOf(f.key), from: f.page + 1, to: f.movedTo + 1 }) : t("replaceFile.pageLine", { name: nameOf(f.key), page: f.page + 1 })}</li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">{t("replaceFile.afterNote")}</p>
        </div>
      )}
    </div>
  );
}

export function ReplaceFileBody({ documentId, fields, onOpenChange, beforeStart, onReplaced }: Props) {
  const t = useTranslations("Sign.editor");
  const tErr = useTranslations("Sign.send");
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<ReplaceAnswer | null>(null);
  const [busy, setBusy] = useState<"checking" | "replacing" | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const choose = async (chosen: File | null) => {
    setPlan(null);
    setErrorCode(null);
    setFile(null);
    if (!chosen) return;
    const problem = checkUploadFile(chosen);
    if (problem) {
      setErrorCode(problem);
      return;
    }
    setFile(chosen);
    setBusy("checking");
    try {
      if (!(await beforeStart())) {
        setErrorCode("save_failed");
        return;
      }
      setPlan(await postReplace(documentId, chosen, true));
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!file || !plan || busy) return;
    setBusy("replacing");
    setErrorCode(null);
    try {
      await postReplace(documentId, file, false);
      onReplaced();
      onOpenChange(false);
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      setBusy(null);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("replaceFile.title")}</DialogTitle>
        <DialogDescription>{t("replaceFile.intro")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <FileDrop file={file} onFile={(f) => void choose(f)} disabled={busy !== null} />

        {busy === "checking" ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("replaceFile.checking")}
          </p>
        ) : null}

        {errorCode ? (
          <p role="alert" className="text-sm text-destructive">
            {tErr(errorKey(errorCode))}
          </p>
        ) : null}

        {plan ? <PlanSummary plan={plan} fields={fields} /> : null}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy === "replacing"} onClick={() => onOpenChange(false)}>
          {t("replaceFile.cancel")}
        </Button>
        <Button type="button" disabled={!plan || busy !== null} onClick={() => void confirm()}>
          {busy === "replacing" ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {busy === "replacing" ? t("replaceFile.replacing") : t("replaceFile.confirm")}
        </Button>
      </DialogFooter>
    </>
  );
}
