"use client";

import { useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import type { KbLanguage } from "@/lib/ai/knowledge-query";
import type { KbStatus } from "@/lib/ai/knowledge-doc";
import type { KnowledgeTestResponse } from "@/lib/knowledge-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { summariseTest } from "./kb-test-utils";

/**
 * "Test it: would the AI find this?" Runs the same search the AI runs and
 * lists the passages it would be given (used) and those that fall under the
 * relevance cut-off. It searches the saved index, so edits that have not
 * been saved are not part of the result, which the box says out loud.
 */
export function KbTestBox({
  articleId,
  status,
  useInAi,
  dirty,
  language,
}: {
  /** null while the article has never been saved. */
  articleId: string | null;
  status: KbStatus;
  useInAi: boolean;
  /** Edits made since the last save. */
  dirty: boolean;
  language: KbLanguage;
}) {
  const t = useTranslations("Knowledge.editor");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ question: string; data: KnowledgeTestResponse } | null>(null);

  async function run() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/knowledge/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, language }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : t("testFailed"));
        return;
      }
      setResult({ question: q, data: data as KnowledgeTestResponse });
    } catch {
      setError(t("testFailed"));
    } finally {
      setBusy(false);
    }
  }

  const searchable = articleId !== null && status === "published" && useInAi;
  const summary = result ? summariseTest(result.data.passages, articleId) : null;

  return (
    <section className="space-y-2 rounded-xl border border-border bg-card p-3" aria-label={t("testTitle")}>
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <FlaskConical className="h-4 w-4 text-muted-foreground" />
        {t("testTitle")}
      </h3>
      <p className="text-xs text-muted-foreground">{t("testHint")}</p>

      {articleId === null ? (
        <p className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">{t("testUnsavedNew")}</p>
      ) : dirty ? (
        <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          {t("testUnsavedEdits")}
        </p>
      ) : !searchable ? (
        <p className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
          {status !== "published" ? t("testNotPublished") : t("testAgentsOnly")}
        </p>
      ) : null}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t("testPlaceholder")}
          aria-label={t("testPlaceholder")}
          className="h-9"
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !question.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("testRun")}
        </Button>
      </form>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {result && summary && (
        <div className="space-y-2" aria-live="polite">
          {articleId && (
            <p
              className={cn(
                "text-xs font-medium",
                summary.thisArticle === "used" && "text-green-700 dark:text-green-400",
                summary.thisArticle === "below" && "text-amber-700 dark:text-amber-400",
                summary.thisArticle === "missing" && "text-destructive",
              )}
            >
              {summary.thisArticle === "used"
                ? t("testVerdictUsed")
                : summary.thisArticle === "below"
                  ? t("testVerdictBelow")
                  : t("testVerdictMissing")}
            </p>
          )}

          {result.data.passages.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("testNoPassages")}</p>
          ) : (
            <ul className="space-y-2">
              {result.data.passages.map((p, i) => (
                <li
                  key={`${p.document_id}-${i}`}
                  className={cn(
                    "rounded-lg border p-2",
                    p.used ? "border-green-500/40 bg-green-500/5" : "border-border bg-muted/30",
                    p.document_id === articleId && "ring-1 ring-primary/40",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-xs font-medium text-foreground">{p.title}</span>
                    {p.document_id === articleId && (
                      <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary">
                        {t("testThisArticle")}
                      </span>
                    )}
                    <span
                      className={cn(
                        "ml-auto text-xs tabular-nums",
                        p.used ? "text-green-700 dark:text-green-400" : "text-muted-foreground",
                      )}
                    >
                      {p.score.toFixed(2)} · {p.used ? t("testUsed") : t("testBelowCutoff")}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{p.text}</p>
                </li>
              ))}
            </ul>
          )}

          <p className="text-[11px] text-muted-foreground">
            {result.data.mode === "meaning" ? t("testModeMeaning") : t("testModeKeyword")}
            {result.data.cutoff_note ? ` · ${t("testCutoff", { note: result.data.cutoff_note })}` : ""}
          </p>
        </div>
      )}
    </section>
  );
}
