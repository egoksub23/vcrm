"use client";

// ============================================================
// Doc Sign forms, the sender's view: the answers so far, read only, grouped by part. Each value is shown the way the
// signer gave it: a choice by its label, a list a line each, a file by name and size with a Download action, a
// picture as a thumbnail when it is available. A value that came from the contact and has not been confirmed says so.
// ============================================================

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, Download, FileText } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SignApiError } from "@/lib/sign/client/api";
import { progressErrorKey, uploadedFileUrl, type AnswerDisplay, type AnswerGroup, type AnswerRowView } from "@/lib/sign/client/progress-logic";
import { cn } from "@/lib/utils";

import { downloadFile } from "../download";
import { formatSize } from "../format";
import { SensitiveAnswer } from "./sensitive-answer";

interface Props {
  documentId: string;
  groups: AnswerGroup[];
  /** The reader may reveal a sensitive answer (sign.send); everyone with the menu sees it masked. */
  canReveal?: boolean;
}

export function AnswersView({ documentId, groups, canReveal = false }: Props) {
  const t = useTranslations("Sign.progress");
  return (
    <section aria-labelledby="sign-answers-title" className="grid gap-3">
      <div>
        <h3 id="sign-answers-title" className="text-sm font-semibold text-foreground">
          {t("answers.title")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("answers.note")}</p>
      </div>
      <ul className="grid gap-2">
        {groups.map((g, i) => (
          <AnswerGroupView key={g.partKey} documentId={documentId} group={g} number={i + 1} defaultOpen={g.answered > 0} canReveal={canReveal} />
        ))}
      </ul>
    </section>
  );
}

function AnswerGroupView({ documentId, group, number, defaultOpen, canReveal }: { documentId: string; group: AnswerGroup; number: number; defaultOpen: boolean; canReveal: boolean }) {
  const t = useTranslations("Sign.progress");
  // A part with answers starts open. Read once when the group first appears: the sender's own opening and closing is kept as the page polls.
  const [open, setOpen] = useState(defaultOpen);
  const panelId = `answers-${group.partKey}`;
  return (
    <li className="rounded-xl border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="min-w-0">
          <span className="block break-words text-sm font-medium text-foreground">
            <span className="text-muted-foreground">{number} </span>
            {group.title}
          </span>
          <span className="block text-xs text-muted-foreground">{t("answers.groupSummary", { role: group.roleLabel, count: group.answered })}</span>
          {group.typedBy ? <span className="block text-xs text-muted-foreground">{t("answers.typedBy", { name: group.typedBy })}</span> : null}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div id={panelId} className="border-t border-border px-4 py-3">
          {group.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("answers.none")}</p>
          ) : (
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
              {group.rows.map((row) => (
                <AnswerRow key={row.key} documentId={documentId} row={row} canReveal={canReveal} />
              ))}
            </dl>
          )}
        </div>
      )}
    </li>
  );
}

function AnswerRow({ documentId, row, canReveal }: { documentId: string; row: AnswerRowView; canReveal: boolean }) {
  const t = useTranslations("Sign.progress");
  return (
    <>
      <dt className="text-xs font-medium text-muted-foreground sm:pt-0.5">{row.label}</dt>
      <dd className="min-w-0 text-sm text-foreground">
        {row.sensitive ? <SensitiveAnswer documentId={documentId} row={row} canReveal={canReveal} /> : <AnswerValue documentId={documentId} label={row.label} display={row.display} />}
        {row.fromContact && <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">{t("answers.fromContact")}</span>}
        {row.bySender && <span className="mt-1 block text-xs text-muted-foreground">{t("answers.bySender")}</span>}
      </dd>
    </>
  );
}

function AnswerValue({ documentId, label, display }: { documentId: string; label: string; display: AnswerDisplay }) {
  const t = useTranslations("Sign.progress");
  switch (display.kind) {
    case "empty":
      return <span className="text-muted-foreground">{t("answers.notAnswered")}</span>;
    case "text":
      return <span className={cn("break-words", display.multiline && "block whitespace-pre-wrap")}>{display.text}</span>;
    case "lines":
      return (
        <ul className="grid gap-0.5">
          {display.lines.map((line, i) => (
            <li key={`${i}-${line}`} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      );
    case "accepted":
      return <span>{t(display.checked ? "answers.accepted" : "answers.notAccepted")}</span>;
    case "image":
      return display.src ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data address the signer drew; there is nothing to optimise
        <img src={display.src} alt={label} className="max-h-24 max-w-full rounded-md border border-border bg-white object-contain" />
      ) : (
        <span className="text-muted-foreground">{t("answers.pictureGiven")}</span>
      );
    case "files":
      return (
        <ul className="grid gap-1.5">
          {display.files.map((file) => (
            <FileLine key={file.id} documentId={documentId} file={file} />
          ))}
        </ul>
      );
  }
}

function FileLine({ documentId, file }: { documentId: string; file: { id: string; name: string; size: number } }) {
  const t = useTranslations("Sign.progress");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      await downloadFile(uploadedFileUrl(documentId, file.id), file.name);
    } catch (err) {
      toast.error(t(progressErrorKey(err instanceof SignApiError ? err.code : "request_failed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 break-all">{file.name}</span>
      <span className="text-xs text-muted-foreground">{formatSize(file.size, locale)}</span>
      <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void download()} aria-label={t("answers.downloadNamed", { name: file.name })}>
        <Download aria-hidden />
        {t("answers.download")}
      </Button>
    </li>
  );
}
