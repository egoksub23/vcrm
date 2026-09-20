"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Languages, Loader2, Paperclip, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { KB_LANGUAGE_LABELS, type KbLanguage } from "@/lib/ai/knowledge-query";
import { translationTargets } from "@/lib/knowledge/translate";
import type { KnowledgeArticle, KnowledgeAttachment, KnowledgeTranslationInfo } from "@/lib/knowledge-types";
import { Button } from "@/components/ui/button";

import { useTranslate } from "../use-translate";
import { createdArticleId } from "../translate-client";
import { formatBytes } from "./kb-editor-utils";

const chip = "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap";

/** The small language tag next to an article title. */
export function KbLanguageChip({ language }: { language: KbLanguage }) {
  const t = useTranslations("Knowledge.translations");
  return (
    <span
      className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
      title={t("articleLanguage", { language: KB_LANGUAGE_LABELS[language] })}
    >
      {KB_LANGUAGE_LABELS[language]}
    </span>
  );
}

function StatusChips({ info }: { info: KnowledgeTranslationInfo }) {
  const t = useTranslations("Knowledge.translations");
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span
        className={cn(
          chip,
          info.status === "published" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground",
        )}
      >
        {info.status === "published" ? t("statusPublished") : t("statusDraft")}
      </span>
      <span
        className={cn(chip, info.machine_translated ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}
      >
        {info.machine_translated ? t("machine") : t("edited")}
      </span>
      {info.out_of_date && (
        <span className={cn(chip, "bg-amber-500/15 text-amber-700 dark:text-amber-400")}>{t("outOfDate")}</span>
      )}
    </span>
  );
}

/**
 * Right-column card of a BASE article: one row per other language with its
 * state and the buttons Translate with AI / Edit / Re-translate, plus
 * "Translate to all". Buttons only appear for someone who may translate this
 * article; a read-only member still sees the list. Translating uses the SAVED
 * article, so the buttons wait while there are unsaved edits.
 */
export function KbTranslationsCard({
  article,
  canTranslate,
  dirty,
  onChanged,
  onLeave,
}: {
  /** null = a new article that has not been saved. */
  article: KnowledgeArticle | null;
  canTranslate: boolean;
  dirty: boolean;
  /** After translations were made or replaced: the parent reloads the article. */
  onChanged: () => void;
  /** Click on a link to another article: the parent asks about unsaved edits. */
  onLeave: (e: React.MouseEvent) => void;
}) {
  const t = useTranslations("Knowledge.translations");
  const router = useRouter();
  const translate = useTranslate();
  const [busy, setBusy] = useState<KbLanguage | "all" | null>(null);

  const targets = article ? translationTargets(article.language) : [];
  const byLanguage = new Map((article?.translations ?? []).map((x) => [x.language, x]));
  const disabled = !article || busy !== null || dirty;

  async function run(languages: KbLanguage[], overwrite: boolean, marker: KbLanguage | "all") {
    if (!article) return;
    setBusy(marker);
    try {
      const outcomes = await translate(article.id, languages, overwrite);
      if (outcomes.length === 1) {
        const id = createdArticleId(outcomes);
        // A new draft opens straight away; a replaced one is already here.
        if (id && !outcomes[0].overwritten) {
          router.push(`/knowledge/${id}`);
          return;
        }
      }
      if (outcomes.some((o) => o.ok)) onChanged();
    } finally {
      setBusy(null);
    }
  }

  function translateOne(language: KbLanguage) {
    const label = KB_LANGUAGE_LABELS[language];
    if (!window.confirm(t("translateConfirm", { language: label, title: article?.title ?? "" }))) return;
    void run([language], false, language);
  }

  function retranslate(language: KbLanguage) {
    if (!window.confirm(t("retranslateConfirm", { language: KB_LANGUAGE_LABELS[language] }))) return;
    void run([language], true, language);
  }

  function translateAll() {
    const anyExists = byLanguage.size > 0;
    if (anyExists && !window.confirm(t("translateAllConfirm"))) return;
    void run(targets, anyExists, "all");
  }

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-3" aria-label={t("title")}>
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Languages className="h-4 w-4 text-muted-foreground" />
          {t("title")}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {!article ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t("saveFirst")}</p>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {targets.map((language) => {
              const info = byLanguage.get(language);
              const working = busy === language || busy === "all";
              return (
                <li key={language} className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-2">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium text-foreground">{KB_LANGUAGE_LABELS[language]}</p>
                    {info ? (
                      <StatusChips info={info} />
                    ) : (
                      <p className="text-xs text-muted-foreground">{t("notTranslated")}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {working && <Loader2 className="h-4 w-4 animate-spin text-primary" aria-label={t("translating")} />}
                    {info ? (
                      <>
                        <Link
                          href={`/knowledge/${info.id}`}
                          onClick={onLeave}
                          className="inline-flex h-7 items-center rounded-md border border-border px-2 text-xs font-medium text-foreground hover:bg-muted"
                        >
                          {t("edit")}
                        </Link>
                        {canTranslate && (
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={disabled} onClick={() => retranslate(language)}>
                            {t("retranslate")}
                          </Button>
                        )}
                      </>
                    ) : (
                      canTranslate && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={disabled} onClick={() => translateOne(language)}>
                          <Sparkles className="mr-1 h-3 w-3" />
                          {t("translate")}
                        </Button>
                      )
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {canTranslate && targets.length > 1 && (
            <Button size="sm" variant="outline" className="w-full" disabled={disabled} onClick={translateAll}>
              {busy === "all" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
              {t("translateAll")}
            </Button>
          )}
          {canTranslate && dirty && <p className="text-xs text-muted-foreground">{t("needsSave")}</p>}
        </>
      )}
    </section>
  );
}

/**
 * On a TRANSLATION: the banner while it is still the machine's text, and the
 * "out of date" banner with Re-translate with AI / Mark up to date / View the
 * original. Nothing here ever runs by itself.
 */
export function KbTranslationBanners({
  article,
  canRetranslate,
  canMarkCurrent,
  dirty,
  onChanged,
  onLeave,
}: {
  article: KnowledgeArticle;
  canRetranslate: boolean;
  canMarkCurrent: boolean;
  dirty: boolean;
  onChanged: () => void;
  onLeave: (e: React.MouseEvent) => void;
}) {
  const t = useTranslations("Knowledge.translations");
  const translate = useTranslate();
  const [busy, setBusy] = useState<"retranslate" | "current" | null>(null);
  const base = article.base;
  if (!article.translation_of || !base) return null;
  if (!article.machine_translated && !article.out_of_date) return null;

  const original = KB_LANGUAGE_LABELS[base.language];
  const wait = busy !== null || dirty;

  async function retranslate() {
    if (!base) return;
    if (!window.confirm(t("retranslateConfirm", { language: KB_LANGUAGE_LABELS[article.language] }))) return;
    setBusy("retranslate");
    try {
      const outcomes = await translate(base.id, [article.language], true);
      if (outcomes.some((o) => o.ok)) onChanged();
    } finally {
      setBusy(null);
    }
  }

  async function markCurrent() {
    setBusy("current");
    try {
      const res = await fetch(`/api/knowledge/${article.id}/mark-current`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof data.error === "string" ? data.error : t("markCurrentFailed"));
        return;
      }
      toast.success(t("markedCurrent"));
      onChanged();
    } catch {
      toast.error(t("markCurrentFailed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      {article.machine_translated && (
        <p className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>{t("bannerMachine", { title: base.title })}</span>
        </p>
      )}
      {article.out_of_date && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span>{t("bannerOutOfDate", { language: original })}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2 pl-6">
            {canRetranslate && (
              <Button size="sm" variant="outline" disabled={wait} onClick={() => void retranslate()}>
                {busy === "retranslate" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
                {t("retranslateWithAi")}
              </Button>
            )}
            {canMarkCurrent && (
              <Button size="sm" variant="outline" disabled={wait} onClick={() => void markCurrent()}>
                {busy === "current" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {t("markCurrent")}
              </Button>
            )}
            <Link
              href={`/knowledge/${base.id}`}
              onClick={onLeave}
              className="inline-flex h-8 items-center rounded-md px-2 text-sm font-medium text-primary hover:underline"
            >
              {t("viewOriginal", { language: original })}
            </Link>
          </div>
          {dirty && <p className="pl-6 text-xs text-muted-foreground">{t("needsSave")}</p>}
        </div>
      )}
    </div>
  );
}

/** The base article's files, read-only, on a translation that has none of its
 *  own: they are what its answers send until it gets files of its own. */
export function KbInheritedFiles({
  files,
  baseLanguage,
  replaced,
}: {
  files: KnowledgeAttachment[];
  baseLanguage: KbLanguage;
  /** The translation has (or is adding) files of its own. */
  replaced: boolean;
}) {
  const t = useTranslations("Knowledge.translations");
  if (files.length === 0) return null;
  const language = KB_LANGUAGE_LABELS[baseLanguage];
  if (replaced) {
    return <p className="text-xs text-muted-foreground">{t("filesReplace", { language })}</p>;
  }
  return (
    <section className="space-y-2 rounded-xl border border-dashed border-border p-3" aria-label={t("inheritedFiles")}>
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Paperclip className="h-4 w-4 text-muted-foreground" />
        {t("inheritedFiles")}
      </h3>
      <p className="text-xs text-muted-foreground">{t("fromBaseFiles", { language })}</p>
      <ul className="space-y-1">
        {files.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-3 text-sm">
            <a href={f.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-primary hover:underline" title={f.file_name}>
              {f.file_name}
            </a>
            <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size_bytes)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
