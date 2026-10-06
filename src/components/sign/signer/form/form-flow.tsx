"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: the form a signer fills in, as screens. Presentational and
// controlled: it holds nothing the page must keep (the answers come in as `view`, every change goes out
// as `onChange`) and makes no request, so the live page and the template builder's "Preview as signer"
// use the very same component.
//
//   overview     every part, progress, Continue, and Review and sign (locked until every required answer is in)
//   a part       its fields, shown or hidden by the answers as they are typed
//
// What it keeps itself is what has no home elsewhere: which screen is open and what is typed in a field
// that is not (yet) an acceptable answer, such as half an email address. The page saves only acceptable
// answers; the rest stays on screen, marked, until it is fixed.
// ============================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Eye } from "lucide-react";
import { useTranslations } from "next-intl";

import type { SaveState, SignerLocale } from "@/lib/sign/client/signer-flow";
import { effectiveAnswers, invalidDrafts, latestSaved, partAfter, partRows, type Drafts, type FormRejections } from "@/lib/sign/client/signer-form";
import type { DataAnswerInput, SignerFormView } from "@/lib/sign/forms/types";
import { cn } from "@/lib/utils";

import { FormOverview } from "./form-overview";
import { FormUiProvider } from "./form-ui";
import { PartScreen } from "./part-screen";

export interface FormFlowProps {
  view: SignerFormView;
  locale: SignerLocale;
  /** Something is being saved or sent: the buttons that need the answers saved wait for it. */
  busy?: boolean;
  onChange: (key: string, input: DataAnswerInput) => void;
  /** Send a file for a file field. Rejects with a SignApiError (its `code` is worded). Not given in a preview. */
  onUpload?: (key: string, file: File, onProgress?: (fraction: number) => void) => Promise<void>;
  onRemoveUpload?: (key: string, fileId: string) => Promise<void>;
  /** The signer checked a part whose answers came from the contact and confirmed it. */
  onConfirmPart?: (partKey: string) => void;
  /** Review and sign (or Submit) was chosen. Only called when it is not locked. */
  onReview: () => void;
  reviewLocked: boolean;
  /** A preview of the form (the builder's "Preview as signer"): it says so, and nothing is sent. */
  preview?: boolean;
  className?: string;

  // ---- what the live page adds (all optional) ----
  /** The document's title, the heading of the overview. */
  title?: string;
  saveState?: SaveState;
  /** Answers the server turned down, by data field key. Marked on their fields until the field changes. */
  rejected?: FormRejections;
  /** One sentence above the form (for instance that some answers need a change). */
  notice?: string | null;
  /** Open on a part (and bring a field into view) instead of the overview. Read once: change the component's `key` to jump again. */
  start?: { part: string; field?: string };
  /** The last row: "Review and sign" (the default), or "Submit" for a person who only fills in. */
  finalAction?: "review" | "submit";
  /** The signer is leaving a part: send what is waiting now rather than after the short pause. */
  onFlush?: () => void;
}

type Screen = { kind: "overview" } | { kind: "part"; key: string; focus?: string };

export function FormFlow(props: FormFlowProps) {
  const { view, locale, busy, onChange, onUpload, onRemoveUpload, onConfirmPart, onReview, reviewLocked, preview, className, title, saveState, rejected, notice, start, finalAction = "review", onFlush } = props;
  return (
    <FormUiProvider value={{ locale }}>
      <Flow
        view={view}
        busy={busy}
        onChange={onChange}
        onUpload={onUpload}
        onRemoveUpload={onRemoveUpload}
        onConfirmPart={onConfirmPart}
        onReview={onReview}
        reviewLocked={reviewLocked}
        preview={preview}
        className={className}
        title={title}
        saveState={saveState}
        rejected={rejected}
        notice={notice}
        start={start}
        finalAction={finalAction}
        onFlush={onFlush}
      />
    </FormUiProvider>
  );
}

const NO_REJECTIONS: FormRejections = {};

function Flow({ view, busy, onChange, onUpload, onRemoveUpload, onConfirmPart, onReview, reviewLocked, preview, className, title, saveState, rejected = NO_REJECTIONS, notice, start, finalAction, onFlush }: Omit<FormFlowProps, "locale">) {
  const t = useTranslations("Sign.signerForm");
  const root = useRef<HTMLDivElement>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [screen, setScreen] = useState<Screen>(() => (start && view.partKeys.includes(start.part) ? { kind: "part", key: start.part, focus: start.field } : { kind: "overview" }));

  const { definition } = view;
  const answers = useMemo(() => effectiveAnswers(definition, view.answers, drafts), [definition, view.answers, drafts]);
  const invalid = useMemo(() => invalidDrafts(definition, answers, drafts), [definition, answers, drafts]);
  const rows = useMemo(() => partRows(definition, view.partKeys, answers, view.progress, new Set(Object.keys(invalid))), [definition, view.partKeys, view.progress, answers, invalid]);
  const lastSavedAt = latestSaved(view.progress);

  const open = screen.kind === "part" ? rows.find((r) => r.part.key === screen.key) : undefined;
  // a part that a condition has just hidden is no longer there to be in
  const shownScreen = open ? `part:${open.part.key}` : "overview";

  // moving to another screen reads its heading out and starts at the top
  const shown = useRef(shownScreen);
  useEffect(() => {
    if (shown.current === shownScreen) return;
    shown.current = shownScreen;
    if (screen.kind === "part" && screen.focus) return;
    const heading = root.current?.querySelector<HTMLElement>("h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    window.scrollTo({ top: 0 });
  }, [shownScreen, screen]);

  function change(key: string, input: DataAnswerInput) {
    setDrafts((cur) => ({ ...cur, [key]: input }));
    onChange(key, input);
  }

  function leave(next: Screen) {
    onFlush?.();
    setScreen(next);
  }

  return (
    <div ref={root} className={cn("space-y-4", className)}>
      {preview ? (
        <p role="note" className="flex items-start gap-2 rounded-lg border border-dashed bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          <Eye className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("preview.note")}
        </p>
      ) : null}
      {notice ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm font-medium text-foreground">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          {notice}
        </p>
      ) : null}

      {open ? (
        <PartScreen
          key={open.part.key}
          definition={definition}
          row={open}
          total={rows.length}
          answers={answers}
          view={view}
          drafts={drafts}
          rejected={rejected}
          invalid={invalid}
          hasNext={!!partAfter(rows, open.part.key)}
          saveState={saveState}
          busy={busy}
          lastSavedAt={lastSavedAt}
          focusField={screen.kind === "part" ? screen.focus : null}
          onInput={change}
          onBack={() => leave({ kind: "overview" })}
          onNext={() => {
            const next = partAfter(rows, open.part.key);
            leave(next ? { kind: "part", key: next.part.key } : { kind: "overview" });
          }}
          onUpload={onUpload}
          onRemoveUpload={onRemoveUpload}
          onConfirmPart={onConfirmPart}
        />
      ) : (
        <FormOverview
          title={title || t("overview.title")}
          rows={rows}
          unlocked={!reviewLocked}
          submit={finalAction === "submit"}
          saveState={saveState}
          busy={busy}
          lastSavedAt={lastSavedAt}
          onOpen={(key) => setScreen({ kind: "part", key })}
          onFinal={() => {
            if (!reviewLocked) onReview();
          }}
        />
      )}
    </div>
  );
}
