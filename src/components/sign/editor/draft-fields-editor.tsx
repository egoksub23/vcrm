"use client";

// ============================================================
// The "Fields" step of a draft: loads the draft, shows the field editor on its file, and saves what the sender
// does (fields, roles and the values of the merge fields) by itself, a moment after each change. A draft made
// from a template opens with the layout locked (only the values change); "Edit fields" unlocks it.
// ============================================================

import { FileUp, LayoutTemplate, Lock, LockOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import { SignApiError, documentFileUrl, signRequest } from "@/lib/sign/client/api";
import type { EditorState } from "@/lib/sign/client/editor-history";
import { errorMessageKey } from "@/lib/sign/client/layout";
import { combineSaveStates } from "@/lib/sign/client/save-queue";
import type { PlacedField } from "@/lib/sign/pdf/types";
import { validateFields, validateRoles } from "@/lib/sign/rules";
import type { SignDocumentRow, SignRole } from "@/lib/sign/types";

import { DraftValuesPanel } from "./draft-values-panel";
import { FieldEditor } from "./field-editor";
import { ReplaceFileDialog } from "./replace-file-dialog";
import { SaveAsTemplateDialog } from "./save-as-template-dialog";
import { SaveStatus } from "./save-status";
import { useSaveQueue } from "./use-save-queue";

interface Loaded {
  title: string;
  fields: PlacedField[];
  roles: SignRole[];
  values: Record<string, string>;
  pageCount: number;
  isDraft: boolean;
  hasFile: boolean;
  fromTemplate: boolean;
}

type Load = { status: "loading" } | { status: "error"; code: string } | { status: "ready"; data: Loaded };

const stringValues = (raw: Record<string, unknown> | null | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) if (v !== null && v !== undefined) out[k] = String(v);
  return out;
};

export function DraftFieldsEditor({ documentId, onChanged }: { documentId: string; onChanged?: () => void }) {
  const t = useTranslations("Sign.editor");
  const canSend = useCapability("sign.send");
  const canTemplates = useCapability("sign.templates");
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [unlocked, setUnlocked] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  // bumped when the file was replaced (F-77): the page viewer starts again on the new file
  const [fileVersion, setFileVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await signRequest<{ document: SignDocumentRow }>(`/api/sign/documents/${documentId}`, { signal: controller.signal });
        const d = res.document;
        setLoad({
          status: "ready",
          data: {
            title: d.title,
            fields: d.fields_snapshot ?? [],
            roles: d.roles_snapshot ?? [],
            values: stringValues(d.merge_values),
            pageCount: d.page_count ?? 0,
            isDraft: d.status === "draft",
            hasFile: !!d.base_path,
            fromTemplate: !!d.template_version_id,
          },
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoad({ status: "error", code: err instanceof SignApiError ? err.code : "request_failed" });
      }
    })();
    return () => controller.abort();
  }, [documentId, attempt]);

  const changed = useCallback(() => onChanged?.(), [onChanged]);
  const layoutQueue = useSaveQueue<EditorState>(async (value) => {
    await signRequest(`/api/sign/documents/${documentId}`, { method: "PATCH", json: { fields: value.fields, roles: value.roles } });
    changed();
  });
  const valuesQueue = useSaveQueue<Record<string, string>>(async (values) => {
    await signRequest(`/api/sign/documents/${documentId}`, { method: "PATCH", json: { mergeValues: values } });
    changed();
  });

  const data = load.status === "ready" ? load.data : null;
  const blockedBy = useMemo(() => (data ? validateRoles(data.roles).length + validateFields(data.fields, data.roles, data.pageCount || 1).length : 0), [data]);

  const onLayout = (next: EditorState) => {
    if (load.status !== "ready") return;
    const issues = validateRoles(next.roles).length + validateFields(next.fields, next.roles, load.data.pageCount || 1).length;
    setLoad((prev) => (prev.status === "ready" ? { status: "ready", data: { ...prev.data, fields: next.fields, roles: next.roles } } : prev));
    // a layout the server would refuse stays on the screen and is sent as soon as it is sound
    if (issues === 0) layoutQueue.schedule(next);
    else layoutQueue.cancel();
  };

  const onValue = (key: string, value: string) => {
    if (load.status !== "ready") return;
    const values = { ...load.data.values, [key]: value };
    setLoad((prev) => (prev.status === "ready" ? { status: "ready", data: { ...prev.data, values: { ...prev.data.values, [key]: value } } } : prev));
    valuesQueue.schedule(values);
  };

  const flushAll = async (): Promise<boolean> => {
    await Promise.all([layoutQueue.flush(), valuesQueue.flush()]);
    return !layoutQueue.unsaved() && !valuesQueue.unsaved();
  };

  if (load.status === "loading") return <p className="py-10 text-center text-sm text-muted-foreground">{t("draft.loading")}</p>;
  if (load.status === "error") {
    return (
      <div role="alert" className="space-y-3 py-10 text-center">
        <p className="text-sm text-destructive">{t(errorMessageKey(load.code))}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => { setLoad({ status: "loading" }); setAttempt((a) => a + 1); }}>
          {t("save.retry")}
        </Button>
      </div>
    );
  }

  const { fields, roles, values, isDraft, hasFile, fromTemplate, title } = load.data;
  if (!hasFile) return <p role="alert" className="py-10 text-center text-sm text-muted-foreground">{t("draft.noFile")}</p>;

  const locked = !isDraft || !canSend;
  const layoutLocked = locked || (fromTemplate && !unlocked);
  const saveState = combineSaveStates([layoutQueue.state, valuesQueue.state]);
  const retry = () => void flushAll();

  const extra = (
    <>
      {isDraft && canSend ? <SaveStatus state={saveState} blockedBy={blockedBy} onRetry={retry} /> : null}
      {fromTemplate && !locked ? (
        <Button type="button" variant="outline" size="sm" aria-pressed={unlocked} onClick={() => setUnlocked((u) => !u)}>
          {unlocked ? <LockOpen /> : <Lock />}
          {unlocked ? t("draft.lockFields") : t("draft.editFields")}
        </Button>
      ) : null}
      {isDraft && canSend ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setReplaceOpen(true)}>
          <FileUp />
          {t("draft.replaceFile")}
        </Button>
      ) : null}
      {canTemplates && isDraft ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setTemplateOpen(true)}>
          <LayoutTemplate />
          {t("draft.saveAsTemplate")}
        </Button>
      ) : null}
    </>
  );

  return (
    <div className="space-y-3">
      {!isDraft ? (
        <p role="status" className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          {t("draft.notDraft")}
        </p>
      ) : !canSend ? (
        <p role="status" className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          {t("draft.noPermission")}
        </p>
      ) : fromTemplate && !unlocked ? (
        <p className="text-sm text-muted-foreground">{t("draft.fromTemplate")}</p>
      ) : null}
      <DraftValuesPanel fields={fields} values={values} readOnly={locked} onChange={onValue} />
      <FieldEditor
        key={fileVersion}
        pdfUrl={documentFileUrl(documentId)}
        fields={fields}
        roles={roles}
        mergeValues={values}
        mode="draft"
        readOnly={layoutLocked}
        onChange={onLayout}
        className="h-[78vh] min-h-[520px]"
        toolbarExtra={extra}
      />
      {isDraft && canSend ? (
        <ReplaceFileDialog
          documentId={documentId}
          fields={fields}
          open={replaceOpen}
          onOpenChange={setReplaceOpen}
          beforeStart={flushAll}
          onReplaced={() => {
            setFileVersion((v) => v + 1);
            setAttempt((a) => a + 1);
            changed();
          }}
        />
      ) : null}
      {canTemplates && isDraft ? <SaveAsTemplateDialog documentId={documentId} defaultName={title} open={templateOpen} onOpenChange={setTemplateOpen} beforeSubmit={flushAll} /> : null}
    </div>
  );
}
