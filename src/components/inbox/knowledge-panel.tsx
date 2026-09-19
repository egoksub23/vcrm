"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { BookOpen, ExternalLink, Loader2, Plus, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { KB_LANGUAGE_LABELS, normalizeLanguage, type KbLanguage } from "@/lib/ai/knowledge-query";
import type { KnowledgeSearchResult } from "@/lib/knowledge-types";

const chip = "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap";

/**
 * The agent's window into the knowledge base, inside the chat composer.
 * With nothing typed it searches on the customer's latest messages, so the
 * likely answer is already listed; typing searches on that instead.
 * "Insert" puts the article text into the reply box for the agent to edit;
 * nothing is ever sent from here.
 */
export function KnowledgePanel({
  suggestQuery,
  contactLanguage,
  canAdd,
  onInsert,
  onAdd,
}: {
  /** The customer's recent messages (empty when there are none yet). */
  suggestQuery: string;
  /** The contact's stored language code, when set. */
  contactLanguage?: string | null;
  canAdd: boolean;
  onInsert: (text: string) => void;
  onAdd: () => void;
}) {
  const t = useTranslations("Inbox.knowledge");
  const [typed, setTyped] = useState("");
  const [results, setResults] = useState<KnowledgeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const seq = useRef(0);

  const query = (typed.trim() || suggestQuery).trim();
  const lang: KbLanguage | null = normalizeLanguage(contactLanguage);
  const usingSuggestion = !typed.trim();

  useEffect(() => {
    if (!query) {
      setResults([]);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, limit: "6" });
        if (lang) params.set("lang", lang);
        const res = await fetch(`/api/knowledge/search?${params}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (mine === seq.current) setResults(res.ok ? (data.results ?? []) : []);
      } catch {
        if (mine === seq.current) setResults([]);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, lang]);

  return (
    <div className="max-h-64 overflow-y-auto rounded-xl border border-border bg-muted/40">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-muted/90 p-1.5 backdrop-blur-sm">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-sm text-foreground outline-none focus:border-primary/50"
          />
        </div>
        {canAdd && (
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground hover:bg-muted"
            title={t("addHint")}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("add")}
          </button>
        )}
      </div>

      {usingSuggestion && query ? (
        <p className="px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("suggested")}
        </p>
      ) : null}

      {loading && results.length === 0 ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : !query ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("typeToSearch")}</p>
      ) : results.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          {usingSuggestion ? t("noSuggestions") : t("noResults")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1 p-1.5">
          {results.map((r) => {
            const open = openId === r.id;
            return (
              <li key={r.id} className="rounded-md border border-transparent bg-card p-2 hover:border-primary/40">
                <div className="flex items-start gap-2">
                  <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-foreground">{r.title}</span>
                      <span className={cn(chip, "bg-muted text-muted-foreground")}>
                        {KB_LANGUAGE_LABELS[r.language]}
                      </span>
                      {!r.use_in_ai && (
                        <span className={cn(chip, "bg-amber-500/15 text-amber-700 dark:text-amber-400")} title={t("agentsOnlyHint")}>
                          {t("agentsOnly")}
                        </span>
                      )}
                    </div>
                    <p className={cn("mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground", !open && "line-clamp-3")}>
                      {open ? r.body : r.snippet}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onInsert(r.body)}
                        className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        {t("insert")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setOpenId(open ? null : r.id)}
                        aria-expanded={open}
                        className="text-[11px] font-medium text-primary hover:underline"
                      >
                        {open ? t("showLess") : t("showFull")}
                      </button>
                      <a
                        href="/knowledge"
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                        title={t("openLibrary")}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
