"use client";

// ============================================================
// Doc Sign, the sending workflow of a draft: ONE screen for a document on its own and for a document collection. The stepper (Documents, People,
// Signature blocks, Review and send), the step, the summary beside it, and the footer with Back and "Continue to <next step>". What differs
// between the two (the routes, what is read) is the `ProcessApi` and the `ProcessSource` the two thin screens hand in
// (`single-process.tsx`, `collection-process.tsx`); everything the sender sees is here.
// ============================================================

import Link from "next/link";
import { AlertCircle, ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useNow } from "@/hooks/use-now";
import { useSignCategories, useSignSettings } from "@/hooks/use-sign-categories";
import { errorKey } from "@/lib/sign/client/errors";
import { PROCESS_STEPS, liteDocs, nextStep, type BlockReason, type ProcessSource, type StepId } from "@/lib/sign/client/process";
import { resolveDefaults } from "@/lib/sign/defaults";

import { FormRolesCard } from "../send/form-roles-card";
import { DocumentStatusBadge } from "../send/status-badge";
import { SaveIndicator } from "../send/save-indicator";
import { SendResult } from "../send/send-result";
import { BlocksStep } from "./blocks-step";
import { DocumentsStep } from "./documents-step";
import { ProcessPeople } from "./people-step";
import { ProcessFooter, ProcessFrame } from "./process-layout";
import { ProcessStepper } from "./process-stepper";
import { ProcessSummary } from "./process-summary";
import { SendStep } from "./send-step";
import { useProcess, type ProcessApi } from "./use-process";

interface Props {
  source: ProcessSource;
  api: ProcessApi;
  /** `?step=` and `?doc=` of the page. */
  asked?: { step?: string | null; doc?: string | null };
  /** The sender asks to see the document or collection (after sending it, or when it turns out it was sent already). */
  onOpen: () => void;
}

/** The sentence for why a step cannot be left yet. */
function useReasonText() {
  const t = useTranslations("Sign.process.blockedWhy");
  return (reason: BlockReason | undefined, count = 0): string | null => (reason ? t(reason, { count }) : null);
}

export function ProcessShell({ source, api, asked, onOpen }: Props) {
  const t = useTranslations("Sign.process");
  const ts = useTranslations("Sign.process.stepper");
  const tw = useTranslations("Sign.send.workspace");
  const te = useTranslations("Sign.send.envelope");
  const tErr = useTranslations("Sign.send");
  const reasonText = useReasonText();
  const now = useNow(60_000);
  const { categories, live } = useSignCategories();
  const { settings, loading: settingsLoading } = useSignSettings();

  const process = useProcess({ source, api, asked });
  const single = process.kind === "single";
  const { step, status, access, options } = process;
  const stepName = (id: StepId) => ts(id === "blocks" && process.formOnly ? "blocksForm" : id);

  const defaults = resolveDefaults({ category: categories.find((c) => c.id === options.categoryId) ?? null, workspace: settings });
  const lite = liteDocs(process.docs);

  if (process.result) {
    const r = process.result;
    return single ? (
      <SendResult
        result={{ documentId: source.id, reference: r.reference, expiresAt: r.expiresAt, invited: r.invited }}
        roles={process.docs[0]?.roles ?? []}
        ordered={options.signInOrder}
        onOpenDocument={onOpen}
        mode={process.formOnly ? "form" : "sign"}
      />
    ) : (
      <SendResult
        result={{ documentId: source.id, reference: r.reference, expiresAt: r.expiresAt, invited: r.invited }}
        roles={[]}
        ordered={options.signInOrder}
        onOpenDocument={onOpen}
        words={{ title: te("sent.title"), subtitle: te("sent.subtitle", { count: r.documents }), open: te("sent.open") }}
      />
    );
  }

  const next = nextStep(step);
  // Continue waits for the earliest step that is not complete (usually this one)
  const blockedBy = next && !access[next].open ? access[next].blockedBy : null;
  const blockedReason = blockedBy ? status[blockedBy] : null;
  const notice = process.blocked ? (
    <p role="status" data-blocked-notice className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-[light-dark(#92400e,#fcd34d)]" aria-hidden />
      <span>{t("blockedNotice", { step: stepName(process.blocked.by), why: reasonText(status[process.blocked.by].reason, status[process.blocked.by].count) ?? "" })}</span>
    </p>
  ) : null;

  const delTitle = single ? tw("deleteTitle") : te("draft.deleteTitle");
  const delBody = single ? tw("deleteBody") : te("draft.deleteBody", { count: process.docs.length });

  const header = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/sign" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden />
            {single ? tw("backToDocuments") : te("draft.back")}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-foreground">{process.title || t("untitled")}</h1>
            <DocumentStatusBadge status="draft" />
            {single ? null : <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{te("badge", { count: process.docs.length })}</span>}
            {source.reference ? <span className="text-xs text-muted-foreground">{source.reference}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <SaveIndicator state={process.saveState} onRetry={process.retrySave} />
          {process.canSend ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => process.setConfirmDelete(true)}>
              <Trash2 aria-hidden />
              {single ? tw("deleteDraft") : te("draft.delete")}
            </Button>
          ) : null}
        </div>
      </div>
      {process.saveErrorCode && process.saveState === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {tErr(errorKey(process.saveErrorCode))}
        </p>
      ) : null}
      {!process.canSend ? (
        <p role="status" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {single ? tw("readOnly") : te("draft.readOnly")}
        </p>
      ) : null}
    </div>
  );

  const body =
    step === "documents" ? (
      <DocumentsStep process={process} envelopeId={single ? null : source.id} />
    ) : step === "people" ? (
      <div className="space-y-3" data-step-body="people">
        <h2 className="text-base font-semibold text-foreground">{t("people.heading")}</h2>
        {process.form ? <FormRolesCard form={process.form} roles={process.docs[0]?.roles ?? []} rows={process.formRows} /> : null}
        <ProcessPeople
          kind={process.kind}
          formOnly={process.formOnly}
          docs={lite}
          workDocs={process.docs}
          people={process.people}
          ordered={options.signInOrder}
          readOnly={!process.canSend}
          showInvalid={process.showInvalid}
          whatsappConfigured={settingsLoading ? null : !!settings?.whatsapp_template_name}
          onPeople={process.changePeople}
          onOrdered={(v) => process.changeOptions({ signInOrder: v })}
        />
      </div>
    ) : step === "blocks" ? (
      <BlocksStep process={process} />
    ) : (
      <SendStep process={process} categories={live} defaultExpiryDays={defaults.expiryDays} now={now} headroom={source.headroom} onOpen={onOpen} />
    );

  return (
    <>
      <ProcessFrame
        header={header}
        stepper={<ProcessStepper current={step} status={status} access={access} onGo={(s) => void process.goStep(s)} formOnly={process.formOnly} />}
        notice={notice}
        summary={<ProcessSummary summary={process.summary} kind={process.kind} onGo={(s, doc) => void process.goStep(s, doc)} />}
        wide={step === "blocks" && (single || !!process.openDocId)}
        stepLabel={stepName(step)}
        footer={
          <ProcessFooter
            step={step}
            nextName={next ? stepName(next) : null}
            busy={process.moving}
            blockedText={blockedReason ? reasonText(blockedReason.reason, blockedReason.count) : null}
            onBack={() => void process.goStep(PROCESS_STEPS[PROCESS_STEPS.indexOf(step) - 1])}
            onContinue={() => next && void process.goStep(next)}
          />
        }
      >
        {body}
      </ProcessFrame>

      <Dialog open={process.confirmDelete} onOpenChange={(o) => (process.deleting ? undefined : process.setConfirmDelete(o))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{delTitle}</DialogTitle>
            <DialogDescription>{delBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={process.deleting} onClick={() => process.setConfirmDelete(false)}>
              {single ? tw("cancel") : te("draft.cancel")}
            </Button>
            <Button type="button" variant="destructive" disabled={process.deleting} onClick={() => void process.deleteDraft(single ? tw("deleted") : te("draft.deleted"))}>
              {process.deleting ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
              {single ? tw("deleteConfirm") : te("draft.deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
