"use client";

// ============================================================
// The form builder (/sign/templates/[id]/form): the parts of a template's form on the left, the data fields of the
// chosen part in the middle, the properties of the chosen field on the right. Saving posts a new template version
// that carries the form; the placement editor is the other view of the same version, so the latest version is
// loaded before every save and whatever this view does not own is carried over unchanged.
// ============================================================

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import { roleColorStyle } from "@/lib/sign/client/colors";
import { SignApiError, type SignIssue } from "@/lib/sign/client/api";
import { loadTemplate, postVersion, snapshotOf, type LoadedTemplate, type VersionItem } from "@/lib/sign/client/form-api";
import { emptyForm, fieldOf, fieldsInPart, partOf, rulesUsing, type FormSeeds } from "@/lib/sign/client/form-edit";
import { builderErrorKey, formWarnings, roleWarnings, type FormWarning, type IssueTarget } from "@/lib/sign/client/form-issues";
import { placementsBoundTo, printCounts } from "@/lib/sign/client/form-printing";
import { planFormSave, type VersionSnapshot } from "@/lib/sign/client/form-save";
import { AUTHOR_LOCALES, coverage } from "@/lib/sign/client/form-text";
import { pick } from "@/lib/sign/forms/text";
import type { DataFieldType } from "@/lib/sign/forms/types";
import { validateForm } from "@/lib/sign/forms/validate";
import type { Issue } from "@/lib/sign/rules";
import type { SignLocale } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { BuilderToolbar } from "./builder-toolbar";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import { FieldProperties } from "./field-properties";
import { FieldsPanel } from "./fields-panel";
import { FormIssuesPanel } from "./form-issues-panel";
import { useLeaveGuard } from "./leave-guard";
import { PartSettings } from "./part-settings";
import { PartsPanel } from "./parts-panel";
import { PreviewAsSigner } from "./preview-as-signer";
import { useFormModel } from "./use-form-model";
import { useCustomContactFields, useTemplateUsed } from "./use-workspace-lookups";

type Load = { status: "loading" } | { status: "error"; code: string } | { status: "ready"; data: LoadedTemplate };

export function FormBuilder({ templateId }: { templateId: string }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const t = useTranslations("Sign.formBuilder");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await loadTemplate(templateId, controller.signal);
        setLoad({ status: "ready", data });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoad({ status: "error", code: err instanceof SignApiError ? err.code : "request_failed" });
      }
    })();
    return () => controller.abort();
  }, [templateId, attempt]);

  if (load.status === "loading") return <p className="py-16 text-center text-sm text-muted-foreground">{t("screen.loading")}</p>;
  if (load.status === "error") {
    return (
      <div role="alert" className="space-y-3 py-16 text-center">
        <p className="text-sm text-destructive">{t(builderErrorKey(load.code))}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setLoad({ status: "loading" });
            setAttempt((a) => a + 1);
          }}
        >
          {t("screen.retry")}
        </Button>
      </div>
    );
  }
  return <BuilderScreen key={`${templateId}:${attempt}`} data={load.data} />;
}

type Pane = "parts" | "fields" | "right";
type Confirm = { kind: "field" | "part"; key: string } | null;

/** The builder for a template that has loaded (exported so it can be rendered in tests). */
export function BuilderScreen({ data }: { data: LoadedTemplate }) {
  const t = useTranslations("Sign.formBuilder");
  const uiLocale = useLocale();
  const canEdit = useCapability("sign.templates");
  const { template, version } = data;

  const [snapshot, setSnapshot] = useState<VersionSnapshot | null>(version ? snapshotOf(version) : null);
  const [versionNo, setVersionNo] = useState(version?.version_no ?? 0);
  const [versionIds, setVersionIds] = useState<string[]>(data.versions.map((v: VersionItem) => v.id));
  const roles = useMemo(() => snapshot?.roles ?? [], [snapshot]);
  const readOnly = !canEdit || !snapshot;

  const seeds = useMemo<FormSeeds>(
    () => ({ newPart: t("seeds.newPart"), newField: t("seeds.newField"), option: (n) => t("seeds.option", { n }), acknowledgeText: t("seeds.acknowledgeText"), copySuffix: t("seeds.copySuffix") }),
    [t],
  );
  const model = useFormModel({ form: snapshot?.form ?? emptyForm(), placements: snapshot?.fields ?? [] }, seeds);
  const { form, placements } = model;

  // what was last saved, to know what has changed and which keys are no longer the sender's to change
  const [saved, setSaved] = useState(() => ({ form: snapshot?.form ?? emptyForm(), json: JSON.stringify([snapshot?.form ?? emptyForm(), snapshot?.fields ?? []]) }));
  const dirty = useMemo(() => JSON.stringify([form, placements]) !== saved.json, [form, placements, saved.json]);
  const used = useTemplateUsed(versionIds);
  const customFields = useCustomContactFields();

  const [lang, setLang] = useState<SignLocale>((AUTHOR_LOCALES as readonly string[]).includes(uiLocale) ? (uiLocale as SignLocale) : "en");
  const [partKey, setPartKey] = useState<string | null>(null);
  const [fieldKey, setFieldKey] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("fields");
  const [right, setRight] = useState<"props" | "issues">("props");
  const [partOpen, setPartOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  const [serverWarnings, setServerWarnings] = useState<FormWarning[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const guard = useLeaveGuard(dirty);

  // ---- derived -----------------------------------------------------------------------------------------------------
  const selectedField = fieldKey ? fieldOf(form, fieldKey) : undefined;
  const activePart = (selectedField ? partOf(form, selectedField.part) : undefined) ?? (partKey ? partOf(form, partKey) : undefined) ?? form.parts[0];
  const fieldsHere = activePart ? fieldsInPart(form, activePart.key) : [];
  const counts = useMemo(() => printCounts(placements), [placements]);
  const texts = useMemo(() => Object.fromEntries(AUTHOR_LOCALES.map((l) => [l, coverage(form, l)])), [form]);

  const liveIssues = useMemo(() => validateForm(form, roles, placements), [form, roles, placements]);
  const issues = useMemo(() => {
    const extra = serverIssues.filter((s) => !liveIssues.some((i) => i.code === s.code && i.field === s.field && i.part === s.part && i.role === s.role));
    return extra.length > 0 ? [...liveIssues, ...extra] : liveIssues;
  }, [liveIssues, serverIssues]);
  const warnings = useMemo<FormWarning[]>(() => [...formWarnings(form, placements), ...roleWarnings(form, roles, placements), ...serverWarnings], [form, placements, roles, serverWarnings]);
  const issueParts = useMemo(() => {
    const out = new Set<string>();
    for (const i of issues) {
      if (i.part) out.add(i.part);
      else if (i.field && !i.code.startsWith("placement_")) {
        const f = fieldOf(form, i.field);
        if (f) out.add(f.part);
      }
    }
    return out;
  }, [issues, form]);
  const issueFields = useMemo(() => new Set(issues.filter((i) => i.field && !i.code.startsWith("placement_")).map((i) => i.field as string)), [issues]);

  // keys are the sender's to change until the template has been used; unknown counts as used
  const lockKeys = used !== false;
  const savedField = (key: string) => saved.form.fields.find((f) => f.key === key);
  const keyLocked = (key: string) => lockKeys && !!savedField(key);
  const lockedOptionValues = (key: string): ReadonlySet<string> => (lockKeys ? new Set((savedField(key)?.options ?? []).map((o) => o.value)) : new Set());

  // ---- leaving with unsaved work -------------------------------------------------------------------------------------
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const focusSoon = (name: string) => {
    requestAnimationFrame(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-focus="${name}"]`);
      el?.focus();
      // the seeded name ("New field") is there to be typed over
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
    });
  };

  // ---- selection -----------------------------------------------------------------------------------------------------
  const selectPart = (key: string) => {
    setPartKey(key);
    setFieldKey(null);
    setPane("fields");
  };
  const selectField = (key: string) => {
    const f = fieldOf(form, key);
    if (f) setPartKey(f.part);
    setFieldKey(key);
    setRight("props");
    setPane("right");
  };

  // ---- operations ----------------------------------------------------------------------------------------------------
  const clearServerNotes = () => {
    if (serverIssues.length > 0) setServerIssues([]);
    if (serverWarnings.length > 0) setServerWarnings([]);
  };

  const addPart = () => {
    const role = activePart?.role ?? roles[0]?.key;
    if (!role || readOnly) return;
    const key = model.addPart(role);
    if (!key) return;
    clearServerNotes();
    setPartKey(key);
    setFieldKey(null);
    setPartOpen(true);
    setPane("fields");
    focusSoon("part-title");
  };

  const addField = (type: DataFieldType) => {
    if (!activePart || readOnly) return;
    const key = model.addField(activePart.key, type);
    if (!key) return;
    clearServerNotes();
    setFieldKey(key);
    setRight("props");
    setPane("right");
    focusSoon("field-label");
  };

  const patchField = (key: string, change: Parameters<typeof model.patchField>[1], coalesce?: string) => {
    const next = model.patchField(key, change, coalesce);
    clearServerNotes();
    if (next !== key && fieldKey === key) setFieldKey(next);
  };

  const patchPart = (key: string, change: Parameters<typeof model.patchPart>[1], coalesce?: string) => {
    const next = model.patchPart(key, change, coalesce);
    clearServerNotes();
    if (next !== key && partKey === key) setPartKey(next);
  };

  const noticeText = (n: { places: number; ruleChanges: unknown[] } | null): string | null => {
    if (!n) return null;
    const bits: string[] = [];
    if (n.places > 0) bits.push(t("removed.places", { count: n.places }));
    if (n.ruleChanges.length > 0) bits.push(t("removed.rules", { count: n.ruleChanges.length }));
    return bits.length > 0 ? bits.join(" ") : null;
  };

  const doDelete = (c: NonNullable<Confirm>) => {
    clearServerNotes();
    if (c.kind === "field") {
      const notice = model.removeField(c.key);
      if (fieldKey === c.key) setFieldKey(null);
      const text = noticeText(notice);
      toast.success(text ? `${t("removed.field")} ${text}` : t("removed.field"));
    } else {
      const notice = model.removePart(c.key);
      if (partKey === c.key) setPartKey(null);
      setFieldKey(null);
      const text = noticeText(notice);
      const base = t("removed.part", { count: notice?.fields ?? 0 });
      toast.success(text ? `${base} ${text}` : base);
    }
  };

  const askDelete = (kind: "field" | "part", key: string) => {
    if (kind === "field") {
      const impact = placementsBoundTo(placements, new Set([key])).length + rulesUsing(form, new Set([key])).length;
      if (impact === 0) doDelete({ kind, key });
      else setConfirm({ kind, key });
    } else if (fieldsInPart(form, key).length === 0) {
      doDelete({ kind, key });
    } else {
      setConfirm({ kind, key });
    }
  };

  const openEditor = (focus?: string) => guard.go(`/sign/templates/${template.id}${focus ? `?focus=${encodeURIComponent(focus)}` : ""}`);

  const onIssue = (target: IssueTarget) => {
    if (target.kind === "field") selectField(target.field);
    else if (target.kind === "part") {
      selectPart(target.part);
      setPartOpen(true);
    } else if (target.kind === "placement") openEditor(target.placement);
    else if (target.kind === "role") openEditor();
  };

  // ---- saving ----------------------------------------------------------------------------------------------------------
  const save = async () => {
    if (readOnly || saving || !dirty || !snapshot) return;
    if (issues.length > 0) {
      setError("fix_problems");
      setRight("issues");
      setPane("right");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const latest = await loadTemplate(template.id);
      if (!latest.version) throw new SignApiError("template_has_no_version", "The template has no version.", 409);
      const plan = planFormSave({ loaded: snapshot, latest: snapshotOf(latest.version), form, placements, ops: model.doc.ops });
      if (plan.kind === "conflict") {
        setError("changed_elsewhere");
        return;
      }
      const result = await postVersion(template.id, plan.body);
      const next: VersionSnapshot = { id: result.version.id, fields: plan.body.fields, roles: plan.body.roles, defaults: plan.body.defaults, form: plan.body.form };
      const nextForm = plan.body.form ?? emptyForm();
      setSnapshot(next);
      setVersionNo(result.version.version_no);
      setVersionIds((ids) => [result.version.id, ...ids]);
      setSaved({ form: nextForm, json: JSON.stringify([nextForm, plan.body.fields]) });
      model.reset({ form: nextForm, placements: plan.body.fields });
      setServerIssues([]);
      const staticWarnings = result.warnings.map<FormWarning>((w) => ({ code: w.code, placement: w.field }));
      setServerWarnings(staticWarnings);
      if (staticWarnings.length > 0) {
        setRight("issues");
        toast.warning(t("screen.savedWithWarnings", { n: result.version.version_no, count: staticWarnings.length }));
      } else {
        toast.success(plan.merged ? t("screen.savedMerged", { n: result.version.version_no }) : t("screen.savedVersion", { n: result.version.version_no }));
      }
    } catch (err) {
      if (err instanceof SignApiError) {
        setError(err.code);
        if (err.code === "invalid_layout" || err.code === "bad_form") {
          setServerIssues(err.issues.map((i: SignIssue) => ({ code: i.code, field: i.field, role: i.role, detail: i.detail })));
          setRight("issues");
        }
      } else setError("request_failed");
    } finally {
      setSaving(false);
    }
  };

  // Ctrl or Cmd + S saves; Ctrl or Cmd + Z / Y steps through undo
  const latestSave = useRef(save);
  const latestModel = useRef(model);
  useEffect(() => {
    latestSave.current = save;
    latestModel.current = model;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        void latestSave.current();
        return;
      }
      const inForm = !!(e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']");
      if (inForm || (key !== "z" && key !== "y")) return;
      e.preventDefault();
      if (key === "y" || e.shiftKey) latestModel.current.redo();
      else latestModel.current.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- render ----------------------------------------------------------------------------------------------------------
  if (!snapshot) {
    return (
      <p role="alert" className="py-10 text-center text-sm text-muted-foreground">
        {t(builderErrorKey("template_has_no_version"))}
      </p>
    );
  }

  const errorText = error === "fix_problems" ? t("errors.fix_problems", { count: issues.length }) : error ? t(builderErrorKey(error)) : null;
  const ctx = { form, roles, placements, locale: lang };
  const role = activePart ? roles.find((r) => r.key === activePart.role) : undefined;
  const confirmField = confirm?.kind === "field" ? fieldOf(form, confirm.key) : undefined;
  const confirmPart = confirm?.kind === "part" ? partOf(form, confirm.key) : undefined;
  const confirmKeys = confirm?.kind === "part" ? new Set(fieldsInPart(form, confirm.key).map((f) => f.key)) : confirm ? new Set([confirm.key]) : new Set<string>();
  const confirmPlaces = placementsBoundTo(placements, confirmKeys).length;
  const confirmRules = rulesUsing(form, confirmKeys).length;
  const hasForm = form.parts.length > 0;

  const header = activePart ? (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 truncate text-sm font-semibold">{pick(activePart.title, lang) || t("parts.unnamed")}</h2>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" style={roleColorStyle(role ? role.color : null)}>
          <span aria-hidden className="size-2 rounded-full bg-[var(--rc-solid)]" />
          <span className={cn(!role && "text-destructive")}>{role ? role.label : t("parts.noRole")}</span>
        </span>
        <Button type="button" variant="outline" size="xs" className="ml-auto" aria-expanded={partOpen} onClick={() => setPartOpen((o) => !o)}>
          {partOpen ? t("partSettings.hide") : t("partSettings.show")}
        </Button>
      </div>
      {partOpen ? (
        <PartSettings part={activePart} form={form} roles={roles} lang={lang} readOnly={readOnly} onPatch={patchPart} onDelete={() => askDelete("part", activePart.key)} />
      ) : activePart.description ? (
        <p className="text-xs text-muted-foreground">{pick(activePart.description, lang)}</p>
      ) : null}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="flex h-[calc(100dvh-8rem)] min-h-[560px] flex-col gap-2">
      <BuilderToolbar
        templateId={template.id}
        templateName={template.name}
        onNavigate={guard.go}
        canUndo={model.canUndo}
        canRedo={model.canRedo}
        onUndo={model.undo}
        onRedo={model.redo}
        canPreview={hasForm}
        onPreview={() => setPreviewOpen(true)}
        readOnly={readOnly}
        canEdit={canEdit}
        dirty={dirty}
        saving={saving}
        onSave={() => void save()}
        versionNo={versionNo}
        lang={lang}
        onLang={setLang}
        coverage={texts}
        errorText={errorText}
        problems={issues.length}
        warnings={warnings.length}
        onShowProblems={() => {
          setRight("issues");
          setPane("right");
        }}
      />

      {!hasForm ? (
        <p role="note" className="rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {t("screen.overlayHint")}
        </p>
      ) : null}

      <div className="flex gap-1 lg:hidden" role="tablist" aria-label={t("screen.panes")}>
        {(["parts", "fields", "right"] as const).map((p) => (
          <button key={p} type="button" role="tab" aria-selected={pane === p} onClick={() => setPane(p)} className={cn("h-8 flex-1 rounded-md border text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring", pane === p ? "border-primary bg-primary text-primary-foreground" : "bg-background")}>
            {t(`screen.pane.${p}`)}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 overflow-hidden rounded-lg border bg-background lg:grid-cols-[15rem_minmax(0,1fr)_26rem]">
        <aside className={cn("min-h-0 border-r bg-card lg:block", pane === "parts" ? "block" : "hidden")}>
          <PartsPanel
            form={form}
            roles={roles}
            lang={lang}
            selected={activePart?.key ?? null}
            readOnly={readOnly}
            issueParts={issueParts}
            onSelect={selectPart}
            onAdd={addPart}
            onStep={(key, d) => model.stepPart(key, d)}
            onMove={(key, i) => model.movePart(key, i)}
            onDelete={(key) => askDelete("part", key)}
            onDropField={(fk, pk) => {
              model.moveField(fk, { part: pk, index: Number.MAX_SAFE_INTEGER });
              setPartKey(pk);
            }}
          />
        </aside>

        <section aria-label={t("fields.title")} className={cn("min-h-0 min-w-0 lg:block", pane === "fields" ? "block" : "hidden")}>
          {activePart ? (
            <FieldsPanel
              form={form}
              partKey={activePart.key}
              fields={fieldsHere}
              counts={counts}
              lang={lang}
              selected={selectedField?.key ?? null}
              readOnly={readOnly}
              issueFields={issueFields}
              header={header}
              onSelect={selectField}
              onAdd={addField}
              onStep={(key, d) => model.stepField(key, d)}
              onMove={(key, i) => model.moveField(key, { part: activePart.key, index: i })}
              onDuplicate={(key) => {
                const k = model.duplicateField(key);
                if (k) selectField(k);
              }}
              onDelete={(key) => askDelete("field", key)}
            />
          ) : (
            <div className="space-y-3 p-4">
              <p className="text-sm text-muted-foreground">{t("screen.noParts")}</p>
              {roles.length === 0 ? (
                <div className="space-y-2">
                  <p className="text-sm">{t("screen.needRoles")}</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => openEditor()}>
                    {t("screen.openEditorRoles")}
                  </Button>
                </div>
              ) : readOnly ? null : (
                <Button type="button" onClick={addPart}>
                  {t("parts.add")}
                </Button>
              )}
            </div>
          )}
        </section>

        <aside className={cn("min-h-0 flex-col border-l bg-card lg:flex", pane === "right" ? "flex" : "hidden")}>
          <div role="tablist" aria-label={t("screen.rightTabs")} className="flex shrink-0 border-b">
            {(["props", "issues"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={right === tab}
                onClick={() => setRight(tab)}
                className={cn("relative flex-1 px-1 py-2 text-xs font-medium outline-none focus-visible:bg-muted", right === tab ? "text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:bg-primary" : "text-muted-foreground hover:text-foreground")}
              >
                {t(`screen.tab.${tab}`)}
                {tab === "issues" && issues.length + warnings.length > 0 ? <span className={cn("ml-1 rounded-full px-1.5", issues.length > 0 ? "bg-amber-500/20 text-amber-700 dark:text-amber-300" : "bg-muted text-muted-foreground")}>{issues.length + warnings.length}</span> : null}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {right === "issues" ? (
              <FormIssuesPanel issues={issues} warnings={warnings} ctx={ctx} onSelect={onIssue} onRemovePlacement={readOnly ? undefined : model.removePlacement} />
            ) : selectedField ? (
              <FieldProperties
                field={selectedField}
                form={form}
                placements={placements}
                lang={lang}
                readOnly={readOnly}
                keyLocked={keyLocked(selectedField.key)}
                followsLabel={model.followsLabel(selectedField.key)}
                lockedOptionValues={lockedOptionValues(selectedField.key)}
                customFields={customFields}
                onPatch={patchField}
                onSetKey={(key, next) => {
                  const ok = model.setFieldKey(key, next);
                  if (ok && fieldKey === key) setFieldKey(next);
                  return ok;
                }}
                onChangeType={(key, type) => {
                  clearServerNotes();
                  const removed = model.changeType(key, type);
                  if (removed > 0) toast.success(t("removed.typeBoxes", { count: removed }));
                }}
                onMoveToPart={(key, part) => {
                  model.moveField(key, { part, index: Number.MAX_SAFE_INTEGER });
                  setPartKey(part);
                }}
                onDuplicate={() => {
                  const k = model.duplicateField(selectedField.key);
                  if (k) selectField(k);
                }}
                onDelete={() => askDelete("field", selectedField.key)}
                onOpenEditor={openEditor}
              />
            ) : (
              <p className="p-3 text-sm text-muted-foreground">{t("props.none")}</p>
            )}
          </div>
        </aside>
      </div>

      <PreviewAsSigner open={previewOpen} onOpenChange={setPreviewOpen} form={form} placements={placements} roles={roles} initialLang={lang} />

      <DeleteConfirmDialog
        kind={confirm?.kind ?? null}
        name={confirm?.kind === "part" ? (confirmPart ? pick(confirmPart.title, lang) : "") : confirmField ? pick(confirmField.label, lang) : ""}
        fields={confirmKeys.size}
        places={confirmPlaces}
        rules={confirmRules}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) doDelete(confirm);
          setConfirm(null);
        }}
      />
      {guard.dialog}
    </div>
  );
}
