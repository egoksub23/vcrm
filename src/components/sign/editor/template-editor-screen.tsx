"use client";

// ============================================================
// The full-screen template editor (/sign/templates/[id]): name, status and category in the header, the field
// editor on the template's file, the default options, the list of saved versions. "Save version" adds a new
// immutable version (documents already sent keep theirs); leaving with unsaved changes asks first.
// ============================================================

import { ArrowLeft, History, Save, SlidersHorizontal } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useCapability } from "@/hooks/use-can";
import { SignApiError, signRequest, templateFileUrl } from "@/lib/sign/client/api";
import type { EditorState } from "@/lib/sign/client/editor-history";
import { errorMessageKey } from "@/lib/sign/client/layout";
import { sameDefaults } from "@/lib/sign/client/template-defaults";
import { validateFields, validateRoles } from "@/lib/sign/rules";
import type { SignTemplateVersionRow, TemplateDefaults } from "@/lib/sign/types";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

import { FieldEditor } from "./field-editor";
import { FormRow, NativeSelect } from "./form-bits";
import { TemplateDefaultsPanel } from "./template-defaults-panel";
import { useStableCallback } from "./use-editor-model";

type Status = "draft" | "active" | "archived";
interface TemplateMeta {
  id: string;
  name: string;
  status: Status;
  category_id: string | null;
}
interface VersionItem {
  id: string;
  version_no: number;
  created_at: string;
}
interface Loaded {
  template: TemplateMeta;
  version: SignTemplateVersionRow | null;
  versions: VersionItem[];
}
interface Category {
  id: string;
  name: string;
}
type Load = { status: "loading" } | { status: "error"; code: string } | { status: "ready"; data: Loaded };
type Drawer = "none" | "defaults" | "versions";

export function TemplateEditorScreen({ templateId }: { templateId: string }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const t = useTranslations("Sign.editor");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await signRequest<Loaded>(`/api/sign/templates/${templateId}`, { signal: controller.signal });
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
        <p className="text-sm text-destructive">{t(errorMessageKey(load.code))}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => { setLoad({ status: "loading" }); setAttempt((a) => a + 1); }}>
          {t("save.retry")}
        </Button>
      </div>
    );
  }
  return <Screen key={`${templateId}:${attempt}`} data={load.data} />;
}

function Screen({ data }: { data: Loaded }) {
  const t = useTranslations("Sign.editor");
  const locale = useLocale();
  const router = useRouter();
  const canEdit = useCapability("sign.templates");
  const { template, version } = data;

  const [meta, setMeta] = useState<TemplateMeta>(template);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [layout, setLayout] = useState<EditorState>({ fields: version?.fields ?? [], roles: version?.roles ?? [] });
  const [defaults, setDefaults] = useState<TemplateDefaults>(version?.defaults ?? {});
  const [baseline, setBaseline] = useState({ fields: layout.fields, roles: layout.roles, defaults });
  const [versions, setVersions] = useState<VersionItem[]>(data.versions);
  const [categories, setCategories] = useState<Category[]>([]);
  const [drawer, setDrawer] = useState<Drawer>("none");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);

  const dirty = layout.fields !== baseline.fields || layout.roles !== baseline.roles || !sameDefaults(defaults, baseline.defaults);
  const problems = useMemo(() => validateRoles(layout.roles).length + validateFields(layout.fields, layout.roles, version?.page_count ?? 1).length, [layout, version]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data: rows } = await createClient().from("sign_categories").select("id, name, archived").order("position", { ascending: true }).order("name", { ascending: true });
      if (cancelled || !rows) return;
      setCategories((rows as (Category & { archived: boolean })[]).filter((c) => !c.archived || c.id === template.category_id).map(({ id, name }) => ({ id, name })));
    })();
    return () => {
      cancelled = true;
    };
  }, [template.category_id]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const patchTemplate = async (patch: { name?: string; status?: Status; categoryId?: string | null }): Promise<boolean> => {
    setError(null);
    try {
      const res = await signRequest<{ template: TemplateMeta }>(`/api/sign/templates/${template.id}`, { method: "PATCH", json: patch });
      setMeta((m) => ({ ...m, name: res.template.name, status: res.template.status, category_id: res.template.category_id }));
      return true;
    } catch (err) {
      setError(err instanceof SignApiError ? err.code : "request_failed");
      return false;
    }
  };

  const saveVersion = async () => {
    if (!canEdit || saving || !dirty) return;
    if (problems > 0) {
      setError("fix_problems");
      return;
    }
    setSaving(true);
    setError(null);
    const snapshot = { fields: layout.fields, roles: layout.roles, defaults };
    try {
      const res = await signRequest<{ version: VersionItem }>(`/api/sign/templates/${template.id}/versions`, { json: { fields: snapshot.fields, roles: snapshot.roles, defaults: snapshot.defaults } });
      setBaseline(snapshot);
      setVersions((v) => [{ id: res.version.id, version_no: res.version.version_no, created_at: res.version.created_at }, ...v]);
      toast.success(t("screen.savedVersion", { n: res.version.version_no }));
    } catch (err) {
      setError(err instanceof SignApiError ? err.code : "request_failed");
    } finally {
      setSaving(false);
    }
  };

  // Ctrl or Cmd + S saves a version
  const saveShortcut = useStableCallback(() => void saveVersion());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveShortcut();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveShortcut]);

  const commitName = async () => {
    const next = (nameDraft ?? meta.name).trim();
    setNameDraft(null);
    if (!next || next === meta.name) return;
    await patchTemplate({ name: next });
  };

  const changeStatus = async (next: Status) => {
    if (next === "active" && dirty) {
      setError("save_first");
      return;
    }
    await patchTemplate({ status: next });
  };

  const goBack = () => {
    if (dirty) setLeaveOpen(true);
    else router.push("/sign/templates");
  };

  const when = (iso: string) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const readOnly = !canEdit || !version;
  const errorText = error === "fix_problems" ? t("screen.fixProblems", { count: problems }) : error === "save_first" ? t("screen.saveFirst") : error ? t(errorMessageKey(error)) : null;

  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[560px] flex-col gap-2">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <Button type="button" variant="ghost" size="sm" onClick={goBack}>
          <ArrowLeft />
          {t("screen.back")}
        </Button>
        <FormRow label={t("screen.name")} htmlFor="sign-tpl-name" className="min-w-48 flex-1 sm:max-w-sm">
          <Input id="sign-tpl-name" value={nameDraft ?? meta.name} disabled={!canEdit} maxLength={160} onChange={(e) => setNameDraft(e.target.value)} onBlur={() => void commitName()} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        </FormRow>
        <FormRow label={t("screen.status")} htmlFor="sign-tpl-status" className="w-36">
          <NativeSelect id="sign-tpl-status" value={meta.status} disabled={!canEdit} onChange={(e) => void changeStatus(e.target.value as Status)}>
            <option value="draft">{t("screen.statusDraft")}</option>
            <option value="active">{t("screen.statusActive")}</option>
            <option value="archived">{t("screen.statusArchived")}</option>
          </NativeSelect>
        </FormRow>
        <FormRow label={t("screen.category")} htmlFor="sign-tpl-category" className="w-44">
          <NativeSelect id="sign-tpl-category" value={meta.category_id ?? ""} disabled={!canEdit} onChange={(e) => void patchTemplate({ categoryId: e.target.value || null })}>
            <option value="">{t("template.noCategory")}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </FormRow>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button type="button" variant={drawer === "defaults" ? "default" : "outline"} size="sm" aria-pressed={drawer === "defaults"} onClick={() => setDrawer((d) => (d === "defaults" ? "none" : "defaults"))}>
            <SlidersHorizontal />
            {t("screen.options")}
          </Button>
          <Button type="button" variant={drawer === "versions" ? "default" : "outline"} size="sm" aria-pressed={drawer === "versions"} onClick={() => setDrawer((d) => (d === "versions" ? "none" : "versions"))}>
            <History />
            {t("screen.versions", { count: versions.length })}
          </Button>
          {readOnly ? null : (
            <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void saveVersion()} title="Ctrl+S">
              <Save />
              {saving ? t("screen.saving") : t("screen.saveVersion")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-5 flex-wrap items-center gap-x-3 text-xs" aria-live="polite">
        {errorText ? (
          <p role="alert" className="text-destructive">
            {errorText}
          </p>
        ) : null}
        {!canEdit ? <p className="text-muted-foreground">{t("screen.readOnly")}</p> : dirty ? <p className="font-medium text-amber-700 dark:text-amber-300">{t("screen.unsaved")}</p> : <p className="text-muted-foreground">{t("screen.allSaved")}</p>}
        {canEdit && dirty && problems > 0 ? <p className="text-muted-foreground">{t("screen.fixProblems", { count: problems })}</p> : null}
      </div>

      {drawer === "defaults" ? (
        <section aria-label={t("screen.options")} className="max-h-72 overflow-y-auto rounded-lg border bg-card">
          <TemplateDefaultsPanel defaults={defaults} readOnly={!canEdit} onChange={setDefaults} />
        </section>
      ) : null}
      {drawer === "versions" ? (
        <section aria-label={t("screen.versionsTitle")} className="max-h-72 overflow-y-auto rounded-lg border bg-card">
          {versions.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">{t("screen.noVersions")}</p>
          ) : (
            <ul className="divide-y">
              {versions.map((v, i) => (
                <li key={v.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span>{t("screen.versionLine", { no: v.version_no, when: when(v.created_at) })}</span>
                  {i === 0 ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{t("screen.current")}</span> : null}
                </li>
              ))}
            </ul>
          )}
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">{t("screen.versionsNote")}</p>
        </section>
      ) : null}

      {version ? (
        <FieldEditor
          pdfUrl={templateFileUrl(template.id)}
          fields={layout.fields}
          roles={layout.roles}
          mode="template"
          readOnly={readOnly}
          onChange={setLayout}
          className={cn("min-h-0 flex-1")}
        />
      ) : (
        <p role="alert" className="py-10 text-center text-sm text-muted-foreground">
          {t(errorMessageKey("template_has_no_version"))}
        </p>
      )}

      <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("screen.leaveTitle")}</DialogTitle>
            <DialogDescription>{t("screen.leaveBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setLeaveOpen(false)}>
              {t("screen.stay")}
            </Button>
            <Button type="button" variant="destructive" onClick={() => router.push("/sign/templates")}>
              {t("screen.leave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
