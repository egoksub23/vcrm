"use client";

// ============================================================
// Doc Sign, step 3 of the sending workflow: the signature blocks. The sender opens each document and places the blocks, giving each to a person
// who must sign (the people are step 2's, so they are known here).
//
//   - A document on its own: the editor is shown in the step (the same editor, with "Add a signature block for <Name>" for each person).
//   - A document collection: the step is a card for each document (its title, pages, how many blocks, who has them, and who has nothing to sign
//     there) with "Open editor"; the editor opens in the step for that document, with "Save and next document" and "Back to the documents".
//   - A document with a form (a template with parts) shows its form instead of the page editor, and "Edit fields" opens the editor on request.
//
// A strip of the people who must sign, in the colours the editor draws their blocks in, stays above whatever is shown.
// ============================================================

import { useMemo } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Check, ClipboardList, FileText, Loader2, Pencil, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { DraftFieldsEditor } from "@/components/sign/editor/draft-fields-editor";
import { Button } from "@/components/ui/button";
import { useSignDraft } from "@/hooks/use-sign-draft";
import { ROLE_CLASS, roleColorStyle } from "@/lib/sign/client/colors";
import { errorKey } from "@/lib/sign/client/errors";
import { hasFormParts } from "@/lib/sign/client/progress-logic";
import { documentCover, personColor, personHasWork, roleKeyOn, type DocCover } from "@/lib/sign/client/process";
import { isSigner, type EnvelopePerson } from "@/lib/sign/envelopes";
import { cn } from "@/lib/utils";

import { FormFieldsStep } from "../send/form-fields-step";
import type { Process } from "./use-process";

/** The people who must sign, as coloured chips with how many blocks each has so far: who to give the blocks to. */
export function PeopleStrip({ people, covers }: { people: readonly EnvelopePerson[]; covers: readonly DocCover[] }) {
  const t = useTranslations("Sign.process.blocks");
  const tp = useTranslations("Sign.send.envelope.people");
  const signers = people.filter(isSigner);
  if (signers.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-xl border border-border bg-card px-3 py-2.5" data-people-strip>
      <p className="text-xs font-medium text-muted-foreground">{t("stripLabel")}</p>
      <ul className="flex flex-wrap gap-1.5" aria-label={t("stripLabel")}>
        {signers.map((p, i) => {
          const blocks = covers.reduce((n, c) => n + (c.people.find((x) => x.key === p.key)?.blocks ?? 0), 0);
          const color = covers.map((c) => c.people.find((x) => x.key === p.key)?.color).find((c) => c !== undefined) ?? i % 6;
          const covered = personHasWork(covers, p.key);
          return (
            <li key={p.key} data-person={p.key} data-blocks={blocks} style={roleColorStyle(color)} className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium", ROLE_CLASS.chip)}>
              <span className={cn("size-2 shrink-0 rounded-full", ROLE_CLASS.dot)} aria-hidden />
              <span className="truncate">{p.fullName.trim() || tp("personN", { n: i + 1 })}</span>
              <span className={cn("shrink-0 font-normal", covered ? "" : "text-[light-dark(#92400e,#fcd34d)]")}>{covered ? t("blockCount", { count: blocks }) : t("noBlockYet")}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** What a document has, in a line: how many blocks, and to whom. */
function useStatusLine() {
  const t = useTranslations("Sign.process.blocks");
  return (c: DocCover): string => {
    if (c.formOnly) return c.doc.hasForm ? t("formStatus", { count: c.doc.pageCount ?? 0 }) : t("formEmpty");
    if (c.state === "empty") return t("statusNone");
    const names = c.people.filter((p) => p.covered).map((p) => p.name || t("somebody"));
    return t("statusBlocks", { count: c.blocks, names: names.join(", "), people: names.length });
  };
}

function DocumentCard({ cover, index, onOpen, disabled }: { cover: DocCover; index: number; onOpen: () => void; disabled: boolean }) {
  const t = useTranslations("Sign.process.blocks");
  const tp = useTranslations("Sign.send.envelope.people");
  const statusLine = useStatusLine();
  const { doc } = cover;
  return (
    <li className="space-y-2.5 rounded-xl border border-border bg-card p-4" data-doc-card={doc.id} data-state={cover.state}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{cover.formOnly ? <ClipboardList className="size-4" aria-hidden /> : <FileText className="size-4" aria-hidden />}</span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">
              <span className="text-muted-foreground tabular-nums">{index + 1}.</span> {doc.title}
            </h3>
            <p className="text-xs text-muted-foreground">
              {cover.formOnly || doc.hasForm ? <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 font-medium">{t("formBadge")}</span> : null}
              {cover.formOnly ? null : t("pages", { count: doc.pageCount ?? 0 })}
            </p>
          </div>
        </div>
        <Button type="button" variant={cover.state === "empty" ? "default" : "outline"} disabled={disabled} onClick={onOpen}>
          <Pencil aria-hidden />
          {cover.state === "empty" ? t("openEditor") : t("edit")}
        </Button>
      </div>
      <p className={cn("text-sm", cover.state === "ready" ? "text-[light-dark(#047857,#6ee7b7)]" : cover.state === "empty" ? "text-[light-dark(#92400e,#fcd34d)]" : "text-foreground")} data-status-line>
        {statusLine(cover)}
      </p>
      {cover.people.length > 0 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={t("coverageLabel")}>
          {cover.people.map((p, i) => (
            <li key={p.key} data-covered={p.covered ? "true" : "false"} className={cn("inline-flex items-center gap-1", p.covered ? "text-foreground" : "text-[light-dark(#92400e,#fcd34d)]")}>
              {p.covered ? <Check className="size-3.5 text-[light-dark(#059669,#34d399)]" aria-hidden /> : <X className="size-3.5" aria-hidden />}
              <span className="font-medium">{p.name || tp("personN", { n: i + 1 })}</span>
              <span className="sr-only">{p.covered ? t("hasBlock") : t("nothingHere")}</span>
              {p.covered ? null : <span aria-hidden>{t("nothingHere")}</span>}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** One document's own editor (its page editor, or its form), read from the server as the draft is. */
export function DocumentEditor({ documentId, process }: { documentId: string; process: Process }) {
  const t = useTranslations("Sign.process.blocks");
  const tErr = useTranslations("Sign.send");
  const { data, error, loading, retry } = useSignDraft(documentId);
  // the address and the colour of each person who must sign, by the role they have on this document: two people with one name can be told apart
  // in the editor, and one person has the same colour on every document of a collection
  const { roleEmails, roleColors } = useMemo(() => {
    const doc = process.docs.find((d) => d.id === documentId);
    const emails: Record<string, string> = {};
    const colors: Record<string, number> = {};
    if (!doc) return { roleEmails: emails, roleColors: colors };
    for (const p of process.people) {
      if (!isSigner(p)) continue;
      const key = roleKeyOn(p, doc);
      if (!key) continue;
      colors[key] = personColor(process.people, p.key);
      const email = p.email.trim();
      if (email) emails[key] = email;
    }
    return { roleEmails: emails, roleColors: colors };
  }, [process.docs, process.people, documentId]);
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20" role="status" aria-label={t("loadingEditor")}>
        <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center">
        <AlertCircle className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm text-foreground">{tErr(errorKey(error?.code))}</p>
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          {t("retry")}
        </Button>
      </div>
    );
  }
  const doc = data.document;
  const form = hasFormParts(doc.form_snapshot) ? doc.form_snapshot : null;
  const goPeople = () => void process.goStep("people");
  return form ? (
    <FormFieldsStep documentId={documentId} form={form} roles={doc.roles_snapshot} readOnly={!process.canSend} onChanged={process.refresh} formOnly={doc.mode === "form"} flushRef={process.editorFlush} onGoToPeople={goPeople} roleEmails={roleEmails} roleColors={roleColors} />
  ) : (
    <DraftFieldsEditor documentId={documentId} onChanged={process.refresh} flushRef={process.editorFlush} onGoToPeople={goPeople} roleEmails={roleEmails} roleColors={roleColors} />
  );
}

export function BlocksStep({ process }: { process: Process }) {
  const t = useTranslations("Sign.process.blocks");
  const single = process.kind === "single";
  const covers = process.docs.map((d) => documentCover(d, process.people));
  const openId = single ? (process.docs[0]?.id ?? null) : process.openDocId;
  const at = covers.findIndex((c) => c.doc.id === openId);
  const next = at >= 0 ? covers[at + 1] : undefined;
  const busy = process.moving;

  return (
    <div className="space-y-4" data-step-body="blocks">
      <div>
        <h2 className="text-base font-semibold text-foreground">{process.formOnly ? t("headingForm") : t("heading")}</h2>
        <p className="text-sm text-muted-foreground">{single ? t("introSingle") : openId ? t("introOpen") : t("introCollection")}</p>
      </div>

      <PeopleStrip people={process.people} covers={covers} />

      {openId ? (
        <div className="space-y-3">
          {single ? null : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void process.goStep("blocks", null)}>
                <ArrowLeft aria-hidden />
                {t("backToDocuments")}
              </Button>
              <p className="min-w-0 truncate text-sm font-medium text-foreground">{at >= 0 ? t("editing", { n: at + 1, total: covers.length, title: covers[at].doc.title }) : null}</p>
              <Button type="button" size="sm" disabled={busy} onClick={() => void process.goStep("blocks", next?.doc.id ?? null)}>
                {next ? t("saveAndNext") : t("saveAndBack")}
                <ArrowRight aria-hidden />
              </Button>
            </div>
          )}
          <DocumentEditor key={openId} documentId={openId} process={process} />
        </div>
      ) : (
        <ol className="space-y-3" aria-label={t("listLabel")}>
          {covers.map((c, i) => (
            <DocumentCard key={c.doc.id} cover={c} index={i} disabled={busy || !process.canSend} onOpen={() => void process.goStep("blocks", c.doc.id)} />
          ))}
        </ol>
      )}

      {!process.canSend ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("readOnly")}
        </p>
      ) : null}
    </div>
  );
}
