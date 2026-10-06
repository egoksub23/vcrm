"use client";

// The top of the form builder: back to the library, the name of the template and its two views, undo and redo, preview and
// save; under it the language of the texts, the save state and how many problems there are.

import { ArrowLeft, Eye, Redo2, Save, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import type { Coverage } from "@/lib/sign/client/form-text";
import type { SignLocale } from "@/lib/sign/types";

import { LangTabs } from "./form-bits";
import { TemplateTabs } from "./template-tabs";

interface BuilderToolbarProps {
  templateId: string;
  templateName: string;
  onNavigate: (href: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** The form has parts, so there is something to preview. */
  canPreview: boolean;
  onPreview: () => void;
  readOnly: boolean;
  /** The person may change templates at all (so the read-only note is for them, not for a template with no version). */
  canEdit: boolean;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  versionNo: number;
  lang: SignLocale;
  onLang: (l: SignLocale) => void;
  coverage: Partial<Record<SignLocale, Coverage>>;
  errorText: string | null;
  problems: number;
  warnings: number;
  onShowProblems: () => void;
}

export function BuilderToolbar(p: BuilderToolbarProps) {
  const t = useTranslations("Sign.formBuilder");
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => p.onNavigate("/sign/templates")}>
          <ArrowLeft />
          {t("screen.back")}
        </Button>
        <h1 className="min-w-0 max-w-sm truncate text-base font-semibold" title={p.templateName}>
          {p.templateName}
        </h1>
        <TemplateTabs templateId={p.templateId} current="form" onNavigate={p.onNavigate} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="icon" disabled={!p.canUndo || p.readOnly} aria-label={t("screen.undo")} title={t("screen.undo")} onClick={p.onUndo}>
            <Undo2 />
          </Button>
          <Button type="button" variant="outline" size="icon" disabled={!p.canRedo || p.readOnly} aria-label={t("screen.redo")} title={t("screen.redo")} onClick={p.onRedo}>
            <Redo2 />
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!p.canPreview} onClick={p.onPreview}>
            <Eye />
            {t("screen.preview")}
          </Button>
          {p.readOnly ? null : (
            <Button type="button" size="sm" disabled={!p.dirty || p.saving} onClick={p.onSave} title="Ctrl+S">
              <Save />
              {p.saving ? t("screen.saving") : t("screen.save")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <LangTabs lang={p.lang} onLang={p.onLang} coverage={p.coverage} />
        <div className="flex min-h-5 flex-wrap items-center gap-x-3 text-xs" aria-live="polite">
          {p.errorText ? (
            <p role="alert" className="text-destructive">
              {p.errorText}
            </p>
          ) : null}
          {!p.canEdit ? <p className="text-muted-foreground">{t("screen.readOnly")}</p> : p.dirty ? <p className="font-medium text-amber-700 dark:text-amber-300">{t("screen.unsaved")}</p> : <p className="text-muted-foreground">{t("screen.allSaved", { n: p.versionNo })}</p>}
          <button type="button" className="underline-offset-2 hover:underline" onClick={p.onShowProblems}>
            {p.problems > 0 ? <span className="text-destructive">{t("screen.problems", { count: p.problems })}</span> : p.warnings > 0 ? <span className="text-muted-foreground">{t("screen.warnings", { count: p.warnings })}</span> : null}
          </button>
        </div>
      </div>
    </>
  );
}
