"use client";

import { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { createSearchIndex, searchGuide, type HelpSearchIndex } from "@/lib/help/search";
import type { HelpSearchDoc } from "@/lib/help/types";

// The index is built once per page load, the first time search is opened.
let indexPromise: Promise<HelpSearchIndex> | null = null;

function loadIndex(): Promise<HelpSearchIndex> {
  if (!indexPromise) {
    indexPromise = fetch("/help/search-index.json", { credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) throw new Error(`search index ${res.status}`);
        return res.json() as Promise<HelpSearchDoc[]>;
      })
      .then((docs) => createSearchIndex(docs))
      .catch((err) => {
        indexPromise = null; // allow a retry next time
        throw err;
      });
  }
  return indexPromise;
}

type IndexState = { status: "loading" } | { status: "error" } | { status: "ready"; index: HelpSearchIndex };

interface HelpSearchPanelProps {
  autoFocus?: boolean;
  /** Called after a result is opened (closes the dialog). */
  onNavigate?: () => void;
  className?: string;
}

/** Search box plus keyboard-navigable results. Used in the dialog and on /help. */
export function HelpSearchPanel({ autoFocus, onNavigate, className }: HelpSearchPanelProps) {
  const t = useTranslations("Help");
  const router = useRouter();
  const uid = useId();
  const listId = `${uid}-results`;

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [state, setState] = useState<IndexState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadIndex()
      .then((index) => {
        if (!cancelled) setState({ status: "ready", index });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const results = useMemo(
    () => (state.status === "ready" ? searchGuide(state.index, query) : []),
    [state, query],
  );
  const optionId = (i: number) => `${uid}-opt-${i}`;

  useEffect(() => {
    if (results.length === 0) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // optionId is derived from uid, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, results]);

  const open = (href: string) => {
    router.push(href);
    setQuery("");
    onNavigate?.();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && results.length) {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp" && results.length) {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      const hit = results[active];
      if (hit) {
        e.preventDefault();
        open(hit.href);
      }
    } else if (e.key === "Escape" && query) {
      // First Escape clears the text; the dialog closes on the next one.
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    }
  };

  const trimmed = query.trim();
  const hasResults = results.length > 0;

  return (
    <div className={className}>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="search"
          role="combobox"
          aria-expanded={hasResults}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={hasResults ? optionId(active) : undefined}
          aria-label={t("searchPlaceholder")}
          placeholder={t("searchPlaceholder")}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-11 w-full rounded-lg border border-input bg-background pr-3 pl-10 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
        />
      </div>

      <div className="mt-2" aria-live="polite">
        {!trimmed ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{t("searchHint")}</p>
        ) : state.status === "loading" ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">{t("searchLoading")}</p>
        ) : state.status === "error" ? (
          <p className="px-1 py-2 text-sm text-destructive">{t("searchError")}</p>
        ) : !hasResults ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">{t("searchNoResults", { query: trimmed })}</p>
        ) : null}
      </div>

      {hasResults ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("searchResults")}
          className="mt-1 max-h-[55vh] overflow-y-auto rounded-lg border border-border bg-card"
        >
          {results.map((hit, i) => (
            <li
              key={hit.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
              className={cn("border-b border-border last:border-b-0", i === active && "bg-primary-soft")}
            >
              <Link
                href={hit.href}
                onClick={() => {
                  setQuery("");
                  onNavigate?.();
                }}
                tabIndex={-1}
                className="block px-3 py-2.5"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium text-foreground">{hit.title}</span>
                  <span className="shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
                    {hit.section}
                  </span>
                </span>
                <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
                  {hit.snippet.before}
                  {hit.snippet.match ? <mark className="help-hit">{hit.snippet.match}</mark> : null}
                  {hit.snippet.after}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface HelpSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The Ctrl+K / "/" palette. The panel only mounts while open, so it starts fresh each time. */
export function HelpSearchDialog({ open, onOpenChange }: HelpSearchDialogProps) {
  const t = useTranslations("Help");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[12%] translate-y-0 gap-2 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">{t("searchDialogTitle")}</DialogTitle>
        <DialogDescription className="sr-only">{t("searchHint")}</DialogDescription>
        <HelpSearchPanel autoFocus onNavigate={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
