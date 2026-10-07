"use client";

// ============================================================
// Doc Sign, step 1 of the sending workflow once the drafts exist: shown as done, and still editable. The title of the process (a document's own
// title, or the collection's); for a collection the documents as an ordered list (reorder, add up to six, remove down to two: the collection's
// own routes); for each document "Replace file" (the draft's replace-file service). The files themselves are chosen on the first screen
// (`NewProcess`), which is the same step before anything is made.
// ============================================================

import { useState } from "react";
import { FileText, FileUp } from "lucide-react";
import { useTranslations } from "next-intl";

import { ReplaceFileDialog } from "@/components/sign/editor/replace-file-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EnvelopeData } from "@/hooks/use-sign-envelope";
import { signRequest } from "@/lib/sign/client/api";
import { optionsFlags } from "@/lib/sign/client/draft-options";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { SignDocumentRow } from "@/lib/sign/types";

import { EnvelopeDocuments } from "../envelope/envelope-documents";
import type { Process } from "./use-process";

/** "Replace file" for one draft document: the dialog shows what would happen to the fields before anything changes. */
function ReplaceFile({ documentId, process, disabled }: { documentId: string; process: Process; disabled: boolean }) {
  const t = useTranslations("Sign.editor");
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<PlacedField[]>([]);
  const start = async () => {
    try {
      const res = await signRequest<{ document: SignDocumentRow }>(`/api/sign/documents/${documentId}`);
      setFields(res.document.fields_snapshot ?? []);
    } catch {
      setFields([]);
    }
    setOpen(true);
  };
  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => void start()}>
        <FileUp aria-hidden />
        {t("draft.replaceFile")}
      </Button>
      <ReplaceFileDialog documentId={documentId} fields={fields} open={open} onOpenChange={setOpen} beforeStart={process.flushAll} onReplaced={() => void process.afterDocumentsChanged()} />
    </>
  );
}

export function DocumentsStep({ process, envelopeId }: { process: Process; envelopeId: string | null }) {
  const t = useTranslations("Sign.process.documents");
  const tc = useTranslations("Sign.send.envelope.documents");
  const single = process.kind === "single";
  const flags = optionsFlags(process.options, new Date());
  const issuesByDoc = (id: string) => process.problems.filter((p) => p.document === id).length;
  const readOnly = !process.canSend;

  return (
    <div className="space-y-4" data-step-body="documents">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t("heading")}</h2>
        <p className="text-sm text-muted-foreground">{single ? t("introSingle") : t("introCollection")}</p>
      </div>

      <section className="space-y-1.5 rounded-xl border border-border bg-card p-4 sm:p-5">
        <label htmlFor="process-title" className="text-sm font-medium text-foreground">
          {single ? t("titleSingle") : t("titleCollection")}
        </label>
        <Input id="process-title" value={process.options.title} maxLength={200} disabled={readOnly} aria-invalid={flags.title} onChange={(e) => process.changeOptions({ title: e.target.value })} />
        {flags.title ? (
          <p className="text-xs text-destructive" role="alert">
            {t("titleRequired")}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{single ? t("titleHintSingle") : t("titleHintCollection")}</p>
        )}
      </section>

      <section aria-labelledby="process-docs" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h3 id="process-docs" className="text-sm font-semibold text-foreground">
          {single ? t("fileHeading") : tc("heading")}
        </h3>
        {single || !envelopeId ? (
          <ul className="space-y-2">
            {process.docs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{d.title}</p>
                    <p className="text-xs text-muted-foreground">{[d.reference, d.mode === "form" ? tc("form") : tc("pages", { count: d.pageCount ?? 0 })].filter(Boolean).join(" · ")}</p>
                  </div>
                </div>
                {readOnly ? null : <ReplaceFile documentId={d.id} process={process} disabled={process.moving} />}
              </li>
            ))}
          </ul>
        ) : (
          <EnvelopeDocuments
            envelopeId={envelopeId}
            documents={process.docs as EnvelopeData["documents"]}
            problemCount={issuesByDoc}
            canEdit={!readOnly}
            beforeChange={process.flushAll}
            onChanged={process.afterDocumentsChanged}
            showEdit={false}
            rowExtra={(d) => (readOnly ? null : <ReplaceFile documentId={d.id} process={process} disabled={process.moving} />)}
          />
        )}
      </section>
    </div>
  );
}
