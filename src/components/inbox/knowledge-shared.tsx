"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useCapability } from "@/hooks/use-auth";
import { BookOpen, ExternalLink, FileText, Image as ImageIcon, Loader2, Paperclip, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { KB_LANGUAGE_LABELS, normalizeLanguage, type KbLanguage } from "@/lib/ai/knowledge-query";
import type { KnowledgeAttachment, KnowledgeSearchResult } from "@/lib/knowledge-types";

// Shared by the composer's Knowledge tab, the right-column Knowledge tab and
// the `/kb` picker, so all three search, look and behave the same.

export const kbChip =
  "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap";

/**
 * Searches the knowledge base as the agent (no AI call, so it is instant and
 * free). Debounced; a newer query always wins over a slower older one.
 * `enabled = false` idles the hook and clears the results.
 */
export function useKnowledgeSearch({
  query,
  contactLanguage,
  enabled = true,
  limit = 6,
}: {
  query: string;
  contactLanguage?: string | null;
  enabled?: boolean;
  limit?: number;
}): { results: KnowledgeSearchResult[]; loading: boolean; failed: boolean } {
  const [state, setState] = useState<{
    key: string;
    results: KnowledgeSearchResult[];
    failed: boolean;
  } | null>(null);
  const seq = useRef(0);
  const lang: KbLanguage | null = normalizeLanguage(contactLanguage);
  const trimmed = query.trim();
  const active = enabled && trimmed.length > 0;
  const key = `${trimmed}|${lang ?? ""}|${limit}`;

  useEffect(() => {
    if (!active) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      let next: KnowledgeSearchResult[] = [];
      let failed = false;
      try {
        const params = new URLSearchParams({ q: trimmed, limit: String(limit) });
        if (lang) params.set("lang", lang);
        const res = await fetch(`/api/knowledge/search?${params}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (res.ok) next = (data.results ?? []) as KnowledgeSearchResult[];
        else failed = true;
      } catch {
        failed = true;
      }
      // The API may not send `attachments` on an older deployment.
      next = next.map((r) => ({ ...r, attachments: r.attachments ?? [], body_html: r.body_html ?? null }));
      if (mine === seq.current) setState({ key, results: next, failed });
    }, 300);
    return () => clearTimeout(timer);
  }, [active, trimmed, lang, limit, key]);

  if (!active) return { results: [], loading: false, failed: false };
  // Results for an older query stay on screen (dimmed by the caller through
  // `loading`) until the new ones land, so the list does not flash empty.
  const fresh = state !== null && state.key === key;
  return { results: state?.results ?? [], loading: !fresh, failed: fresh && state.failed };
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** A small file chip: the icon by kind, the name and the size. */
export function FileChip({
  file,
  className,
  onRemove,
  removeLabel,
  prefix,
}: {
  file: Pick<KnowledgeAttachment, "file_name" | "kind" | "size_bytes">;
  className?: string;
  onRemove?: () => void;
  removeLabel?: string;
  prefix?: string;
}) {
  const Icon = file.kind === "image" ? ImageIcon : file.kind === "document" ? FileText : Paperclip;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] text-foreground",
        className,
      )}
      title={`${file.file_name} · ${formatBytes(file.size_bytes)}`}
    >
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      {prefix ? <span className="shrink-0 text-muted-foreground">{prefix}</span> : null}
      <span className="truncate">{file.file_name}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="-mr-0.5 shrink-0 rounded px-0.5 text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

/** One article in a search list: title, collection, snippet, its files, and
 *  the Insert / Open / Draft with AI actions. */
export function KnowledgeCard({
  result,
  expanded = false,
  onToggleExpanded,
  onInsert,
  onDraft,
  draftBusy = false,
}: {
  result: KnowledgeSearchResult;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** Omit to hide "Insert" (a read-only viewer can browse but not reply). */
  onInsert?: (r: KnowledgeSearchResult) => void;
  /** Omit to hide "Draft with AI". */
  onDraft?: (r: KnowledgeSearchResult) => void;
  draftBusy?: boolean;
}) {
  const t = useTranslations("Inbox.knowledge");
  const tk = useTranslations("Knowledge.agent");
  // "Open" goes to the Knowledge page: only offered with menu.knowledge.
  const canOpenKnowledge = useCapability("menu.knowledge");
  const r = result;
  const canDraft = !!onDraft && r.use_in_ai;

  return (
    <div className="rounded-md border border-transparent bg-card p-2 hover:border-primary/40">
      <div className="flex items-start gap-2">
        <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">{r.title}</span>
            {r.category ? <span className={cn(kbChip, "bg-primary/10 text-primary")}>{r.category}</span> : null}
            <span className={cn(kbChip, "bg-muted text-muted-foreground")}>{KB_LANGUAGE_LABELS[r.language]}</span>
            {!r.use_in_ai && (
              <span
                className={cn(kbChip, "bg-muted text-muted-foreground ring-1 ring-border")}
                title={t("agentsOnlyHint")}
              >
                {t("agentsOnly")}
              </span>
            )}
          </div>
          <p
            className={cn(
              "mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground",
              !expanded && "line-clamp-3",
            )}
          >
            {expanded ? r.body : r.snippet}
          </p>
          {r.attachments.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1" title={tk("filesHint")}>
              {r.attachments.map((a) => (
                <FileChip key={a.id} file={a} />
              ))}
            </div>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {onInsert ? (
              <button
                type="button"
                onClick={() => onInsert(r)}
                className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t("insert")}
              </button>
            ) : null}
            {canOpenKnowledge ? (
              <a
                href={`/knowledge/${r.id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted"
                title={t("openLibrary")}
              >
                <ExternalLink className="h-3 w-3" />
                {tk("open")}
              </a>
            ) : null}
            {canDraft ? (
              <button
                type="button"
                onClick={() => onDraft(r)}
                disabled={draftBusy}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
                title={tk("draftWithAiHint")}
              >
                {draftBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                {tk("draftWithAi")}
              </button>
            ) : null}
            {onToggleExpanded ? (
              <button
                type="button"
                onClick={onToggleExpanded}
                aria-expanded={expanded}
                className="ml-auto text-[11px] font-medium text-primary hover:underline"
              >
                {expanded ? t("showLess") : t("showFull")}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
