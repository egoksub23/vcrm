"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, ArrowRight, Loader2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DraftFieldsEditor } from "@/components/sign/editor/draft-fields-editor";
import { useCapability } from "@/hooks/use-can";
import { useNow } from "@/hooks/use-now";
import { useSignCategories, useSignSettings } from "@/hooks/use-sign-categories";
import { combineSaveStates, useAutosave } from "@/hooks/use-sign-autosave";
import { useSignDraft, type DraftData } from "@/hooks/use-sign-draft";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { resolveDefaults } from "@/lib/sign/defaults";
import { isEmptyPatch, optionsFromDocument, optionsPatch, type DraftOptions } from "@/lib/sign/client/draft-options";
import { draftProblems } from "@/lib/sign/client/draft-problems";
import { errorKey, problemStep, type DraftStep } from "@/lib/sign/client/errors";
import { payloadKey, rowHasInput, rowIsComplete, rowsForRoles, rowsFromSigners, toPayload, type SignerRow } from "@/lib/sign/client/signers-form";
import type { SignDocumentRow, SignSignerRow } from "@/lib/sign/types";
import { OptionsStep } from "./options-step";
import { PeopleStep } from "./people-step";
import { ReviewStep } from "./review-step";
import { SaveIndicator } from "./save-indicator";
import { SendResult, type SendResultData } from "./send-result";
import { DRAFT_STEPS, StepsNav, type DraftStepId } from "./steps-nav";
import { DocumentStatusBadge } from "./status-badge";

interface Props {
  documentId: string;
  /** Called when the sender asks to see the document (after sending it, or when it turns out it was sent already). */
  onOpenDocument: () => void;
}

/**
 * A draft being prepared: place the fields, say who signs, set the options, review, send. The people and the
 * options save by themselves as they are edited (and when a step is left); the fields editor saves its own.
 */
export function DraftWorkspace({ documentId, onOpenDocument }: Props) {
  const t = useTranslations("Sign.send.workspace");
  const tErr = useTranslations("Sign.send");
  const { data, error, loading, reload, retry, setDocument } = useSignDraft(documentId);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24" role="status" aria-label={t("loading")}>
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div role="alert" className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center">
        <AlertCircle className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm text-foreground">{tErr(errorKey(error?.code))}</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            {t("retry")}
          </Button>
          <Link href="/sign" className="inline-flex h-7 items-center rounded-lg px-2.5 text-[0.8rem] font-medium text-primary hover:underline">
            {t("backToDocuments")}
          </Link>
        </div>
      </div>
    );
  }
  if (data.document.status !== "draft") {
    return (
      <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center" role="status">
        <p className="text-sm text-foreground">{t("alreadySent")}</p>
        <Button type="button" onClick={onOpenDocument}>
          {t("openDocument")}
        </Button>
      </div>
    );
  }
  return <LoadedWorkspace key={documentId} documentId={documentId} data={data} reload={reload} setDocument={setDocument} onOpenDocument={onOpenDocument} />;
}

function initialStep(doc: SignDocumentRow, signers: readonly SignSignerRow[]): DraftStepId {
  if (doc.fields_snapshot.length === 0 || doc.roles_snapshot.length === 0) return "fields";
  return signers.length === 0 ? "people" : "review";
}

interface LoadedProps {
  documentId: string;
  data: DraftData;
  reload: () => Promise<DraftData | null>;
  setDocument: (doc: SignDocumentRow) => void;
  onOpenDocument: () => void;
}

function LoadedWorkspace({ documentId, data, reload, setDocument, onOpenDocument }: LoadedProps) {
  const t = useTranslations("Sign.send.workspace");
  const tErr = useTranslations("Sign.send");
  const router = useRouter();
  const canSend = useCapability("sign.send");
  const now = useNow(60_000);
  const { categories, live } = useSignCategories();
  const { settings, loading: settingsLoading } = useSignSettings();

  const doc = data.document;
  const roles = doc.roles_snapshot;

  // What the screen starts from; read once. Afterwards these are the sender's own edits.
  const [init] = useState(() => {
    const saved = rowsFromSigners(data.signers);
    return {
      rows: saved.length > 0 ? saved : rowsForRoles(doc.roles_snapshot),
      savedPeopleKey: payloadKey(toPayload(saved, doc.roles_snapshot)),
      options: optionsFromDocument(doc),
      step: initialStep(doc, data.signers),
    };
  });
  const [step, setStep] = useState<DraftStepId>(init.step);
  const [rows, setRows] = useState<SignerRow[]>(init.rows);
  const [options, setOptions] = useState<DraftOptions>(init.options);
  const [peopleInvalid, setPeopleInvalid] = useState(false);
  const [optionsInvalid, setOptionsInvalid] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendErrorCode, setSendErrorCode] = useState<string | null>(null);
  const [saveErrorCode, setSaveErrorCode] = useState<string | null>(null);
  const [result, setResult] = useState<SendResultData | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // The latest values, for the saves (which run later than the render that made them).
  const rowsRef = useRef(init.rows);
  const optionsRef = useRef(init.options);
  const rolesRef = useRef(roles);
  const savedPeopleKey = useRef(init.savedPeopleKey);
  const savedOptions = useRef(init.options);
  const deleted = useRef(false);
  useEffect(() => {
    rolesRef.current = roles;
  });

  const people = useAutosave(async () => {
    if (deleted.current) return;
    const payload = toPayload(rowsRef.current, rolesRef.current);
    const key = payloadKey(payload);
    if (key === savedPeopleKey.current) return;
    try {
      await signRequest(`/api/sign/documents/${documentId}/signers`, { method: "PUT", json: { signers: payload } });
      savedPeopleKey.current = key;
      setSaveErrorCode(null);
    } catch (err) {
      setSaveErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      throw err;
    }
  });

  const optionsSave = useAutosave(async () => {
    if (deleted.current) return;
    const patch = optionsPatch(savedOptions.current, optionsRef.current, new Date());
    if (isEmptyPatch(patch)) return;
    try {
      const res = await signRequest<{ document: SignDocumentRow }>(`/api/sign/documents/${documentId}`, { method: "PATCH", json: patch });
      savedOptions.current = optionsFromDocument(res.document);
      setDocument(res.document);
      setSaveErrorCode(null);
    } catch (err) {
      setSaveErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      throw err;
    }
  });

  const flushAll = async (): Promise<boolean> => (await Promise.all([people.flush(), optionsSave.flush()])).every(Boolean);

  const changeRows = (next: SignerRow[]) => {
    rowsRef.current = next;
    setRows(next);
    people.touch();
  };
  const changeOptions = (patch: Partial<DraftOptions>) => {
    const next = { ...optionsRef.current, ...patch };
    optionsRef.current = next;
    setOptions(next);
    optionsSave.touch();
  };

  const categoryId = options.categoryId;
  const defaults = resolveDefaults({ category: categories.find((c) => c.id === categoryId) ?? null, workspace: settings });
  const facts = { fields: doc.fields_snapshot, roles, pageCount: doc.page_count ?? 0, hasBaseFile: !!doc.base_path };
  const nowDate = new Date(now);
  const liveProblems = draftProblems({ facts, rows, options, now: nowDate });
  const reviewProblems = draftProblems({ facts, rows, options, serverProblems: data.problems, now: nowDate });
  const noProblemsAt = (s: DraftStep) => !liveProblems.some((p) => problemStep(p.code) === s);
  const done = {
    fields: roles.length > 0 && doc.fields_snapshot.length > 0 && noProblemsAt("fields"),
    people: rows.length > 0 && noProblemsAt("people"),
    options: noProblemsAt("options"),
    review: false,
  };

  const goStep = (next: DraftStepId) => {
    if (next === step) return;
    if (step === "people") setPeopleInvalid(true);
    if (step === "options") setOptionsInvalid(true);
    if (next === "people" && rowsRef.current.length === 0 && roles.length > 0) {
      const seeded = rowsForRoles(roles);
      rowsRef.current = seeded;
      setRows(seeded);
    }
    setStep(next);
    if (next === "review") {
      setChecking(true);
      setSendErrorCode(null);
      void (async () => {
        await flushAll();
        await reload();
        setChecking(false);
      })();
    } else {
      void flushAll();
    }
  };
  const stepIndex = DRAFT_STEPS.indexOf(step);

  const send = async () => {
    if (sending) return;
    setSending(true);
    setSendErrorCode(null);
    try {
      if (!(await flushAll())) {
        setSendErrorCode("save_failed");
        return;
      }
      setResult(await signRequest<SendResultData>(`/api/sign/documents/${documentId}/send`, { method: "POST" }));
    } catch (err) {
      setSendErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      void reload();
    } finally {
      setSending(false);
    }
  };

  const deleteDraft = async () => {
    setDeleting(true);
    try {
      deleted.current = true;
      await signRequest(`/api/sign/documents/${documentId}`, { method: "DELETE" });
      toast.success(t("deleted"));
      router.push("/sign");
    } catch (err) {
      deleted.current = false;
      setDeleting(false);
      setConfirmDelete(false);
      toast.error(tErr(errorKey(err instanceof SignApiError ? err.code : "request_failed")));
    }
  };

  if (result) {
    return <SendResult result={result} roles={roles} ordered={options.signInOrder} onOpenDocument={onOpenDocument} />;
  }

  const saveState = combineSaveStates([people.state, optionsSave.state]);
  const category = categories.find((c) => c.id === options.categoryId);
  const unsavedPeople = rows.filter((r) => rowHasInput(r) && !rowIsComplete(r, roles)).length;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/sign" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden />
            {t("backToDocuments")}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-foreground">{options.title.trim() || doc.title}</h1>
            <DocumentStatusBadge status="draft" />
            {doc.reference ? <span className="text-xs text-muted-foreground">{doc.reference}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <SaveIndicator
            state={saveState}
            onRetry={() => {
              void flushAll();
            }}
          />
          {canSend ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 aria-hidden />
              {t("deleteDraft")}
            </Button>
          ) : null}
        </div>
      </div>

      {saveErrorCode && saveState === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {tErr(errorKey(saveErrorCode))}
        </p>
      ) : null}
      {!canSend ? (
        <p role="status" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t("readOnly")}
        </p>
      ) : null}

      <StepsNav current={step} done={done} onGo={goStep} />

      <div>
        {step === "fields" ? (
          <DraftFieldsEditor documentId={documentId} onChanged={() => void reload()} />
        ) : step === "people" ? (
          <>
            <PeopleStep
              roles={roles}
              rows={rows}
              signInOrder={options.signInOrder}
              showInvalid={peopleInvalid}
              whatsappConfigured={settingsLoading ? null : !!settings?.whatsapp_template_name}
              readOnly={!canSend}
              onRows={changeRows}
              onSignInOrder={(v) => changeOptions({ signInOrder: v })}
              onGoToFields={() => goStep("fields")}
            />
            {unsavedPeople > 0 ? <p className="mt-3 text-xs text-muted-foreground">{t("unsavedPeople", { count: unsavedPeople })}</p> : null}
          </>
        ) : step === "options" ? (
          <OptionsStep options={options} categories={live} defaultExpiryDays={defaults.expiryDays} now={now} showInvalid={optionsInvalid} readOnly={!canSend} onChange={changeOptions} />
        ) : (
          <>
            <ReviewStep
              roles={roles}
              rows={rows}
              options={options}
              categoryName={category?.name ?? null}
              contactName={null}
              defaultExpiryDays={defaults.expiryDays}
              now={now}
              problems={reviewProblems}
              checking={checking}
              canSend={canSend}
              sending={sending}
              sendErrorCode={sendErrorCode}
              onSend={() => void send()}
              onGoToStep={goStep}
            />
            {sendErrorCode === "document_not_draft" ? (
              <div className="mt-3 flex justify-end">
                <Button type="button" variant="outline" onClick={onOpenDocument}>
                  {t("openDocument")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" disabled={stepIndex === 0} onClick={() => goStep(DRAFT_STEPS[stepIndex - 1])}>
          <ArrowLeft aria-hidden />
          {t("back")}
        </Button>
        {stepIndex < DRAFT_STEPS.length - 1 ? (
          <Button type="button" onClick={() => goStep(DRAFT_STEPS[stepIndex + 1])}>
            {t("next")}
            <ArrowRight aria-hidden />
          </Button>
        ) : null}
      </div>

      <Dialog open={confirmDelete} onOpenChange={(o) => (deleting ? undefined : setConfirmDelete(o))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>{t("deleteBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={deleting} onClick={() => setConfirmDelete(false)}>
              {t("cancel")}
            </Button>
            <Button type="button" variant="destructive" disabled={deleting} onClick={() => void deleteDraft()}>
              {deleting ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
              {t("deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
