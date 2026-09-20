"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Plus, Search } from "lucide-react";

import type { KnowledgeSearchResult } from "@/lib/knowledge-types";
import { KnowledgeCard, useKnowledgeSearch } from "./knowledge-shared";

/**
 * The agent's window into the knowledge base, inside the chat composer.
 * With nothing typed it searches on the customer's latest messages, so the
 * likely answer is already listed; typing searches on that instead.
 * "Insert" puts the article text (and stages its files) in the reply box for
 * the agent to edit; nothing is ever sent from here.
 */
export function KnowledgePanel({
  suggestQuery,
  contactLanguage,
  canAdd,
  onInsert,
  onDraft,
  draftingId,
  onAdd,
}: {
  /** The customer's recent messages (empty when there are none yet). */
  suggestQuery: string;
  /** The contact's stored language code, when set. */
  contactLanguage?: string | null;
  canAdd: boolean;
  onInsert: (article: KnowledgeSearchResult) => void;
  /** Writes a reply from one article with the AI. Omit to hide the button. */
  onDraft?: (article: KnowledgeSearchResult) => void;
  draftingId?: string | null;
  onAdd: () => void;
}) {
  const t = useTranslations("Inbox.knowledge");
  const [typed, setTyped] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const query = (typed.trim() || suggestQuery).trim();
  const usingSuggestion = !typed.trim();
  const { results, loading } = useKnowledgeSearch({ query, contactLanguage });

  return (
    <div className="max-h-72 overflow-y-auto">
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
          {results.map((r) => (
            <li key={r.id}>
              <KnowledgeCard
                result={r}
                expanded={openId === r.id}
                onToggleExpanded={() => setOpenId(openId === r.id ? null : r.id)}
                onInsert={onInsert}
                onDraft={onDraft}
                draftBusy={draftingId === r.id}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
