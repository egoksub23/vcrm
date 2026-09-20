"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import type { Message } from "@/types";
import type { KnowledgeSearchResult } from "@/lib/knowledge-types";
import { buildKnowledgeQuery } from "@/lib/inbox/kb-agent";
import { requestKbDraft, requestKbInsert } from "@/lib/inbox/kb-bus";
import { useCapability } from "@/hooks/use-can";
import { KnowledgeCard, useKnowledgeSearch } from "./knowledge-shared";

/**
 * The "Knowledge" tab in the chat's right-hand column: articles suggested
 * for this conversation (from the customer's latest messages), plus a search
 * box. Insert and Draft with AI are handed to the reply box, which knows the
 * channel and formats the text for it. Nothing is sent from here.
 */
export function KnowledgeTab({
  messages,
  contactLanguage,
  hasConversation,
}: {
  /** The open conversation's messages, for the suggestions. */
  messages: Message[];
  contactLanguage?: string | null;
  hasConversation: boolean;
}) {
  const t = useTranslations("Inbox.knowledge");
  const tk = useTranslations("Knowledge.agent");
  const canSend = useCapability("knowledge.draft");
  const [typed, setTyped] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const suggestQuery = useMemo(() => buildKnowledgeQuery(messages), [messages]);
  const usingSuggestion = !typed.trim();
  const query = (typed.trim() || suggestQuery).trim();
  const { results, loading, failed } = useKnowledgeSearch({ query, contactLanguage });

  const insert = (r: KnowledgeSearchResult) => {
    requestKbInsert(r);
    toast.success(tk("insertedToast", { title: r.title }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-sm text-foreground outline-none focus:border-primary/50"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {usingSuggestion && query ? (
          <p className="px-3 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("suggested")}
          </p>
        ) : null}

        {loading && results.length === 0 ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : !query ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {hasConversation ? t("typeToSearch") : tk("noConversation")}
          </p>
        ) : failed ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">{tk("loadFailed")}</p>
        ) : results.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
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
                  onInsert={canSend && hasConversation ? insert : undefined}
                  onDraft={canSend && hasConversation ? (a) => requestKbDraft(a.id) : undefined}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
