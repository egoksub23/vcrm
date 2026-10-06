"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, FileSignature, Loader2, Plus, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNow } from "@/hooks/use-now";
import { useCapability } from "@/hooks/use-can";
import { useSignCategories } from "@/hooks/use-sign-categories";
import { useSignDocuments } from "@/hooks/use-sign-documents";
import { EMPTY_FILTERS, STATUS_GROUPS, isFiltered, type ListFilters, type StatusGroup } from "@/lib/sign/client/list-filters";
import { cn } from "@/lib/utils";
import { DocumentCards, DocumentTable } from "./document-rows";

/** The Documents tab: filter chips with counts, category and search, then the documents 25 at a time. */
export function DocumentsList() {
  const t = useTranslations("Sign.send.list");
  const canSend = useCapability("sign.send");
  const now = useNow(60_000);
  const { categories, live } = useSignCategories();

  const [group, setGroup] = useState<StatusGroup>("all");
  const [category, setCategory] = useState<string>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const filters: ListFilters = { group, category, search };
  const { rows, counts, loading, refreshing, error, hasMore, loadingMore, loadMoreFailed, loadMore, reload } = useSignDocuments(filters);
  const filtered = isFiltered(filters) || searchInput.trim() !== "";
  const clearFilters = () => {
    setGroup(EMPTY_FILTERS.group);
    setCategory(EMPTY_FILTERS.category);
    setSearchInput("");
    setSearch("");
  };
  const total = counts?.[group] ?? rows.length;
  const nothingAtAll = !loading && !error && rows.length === 0 && !filtered;

  return (
    <div className="space-y-4">
      {!nothingAtAll ? (
        <>
          <div role="group" aria-label={t("filterByStatus")} className="flex flex-wrap gap-2">
            {STATUS_GROUPS.map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={group === g}
                onClick={() => setGroup(g)}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  group === g ? "border-primary bg-primary/10 font-medium text-foreground" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {t(`group.${g}`)}
                {counts ? <span className="text-xs tabular-nums text-muted-foreground">{counts[g]}</span> : null}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input type="search" aria-label={t("searchLabel")} placeholder={t("searchPlaceholder")} className="h-9 pl-8" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
            </div>
            <select
              aria-label={t("categoryLabel")}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-56"
            >
              <option value="all">{t("allCategories")}</option>
              <option value="none">{t("noCategory")}</option>
              {live.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              {category !== "all" && category !== "none" && !live.some((c) => c.id === category) ? <option value={category}>{categories.find((c) => c.id === category)?.name ?? category}</option> : null}
            </select>
          </div>
        </>
      ) : null}

      {loading ? (
        <div className="space-y-2" role="status" aria-label={t("loading")}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl border border-border bg-muted/40" />
          ))}
        </div>
      ) : error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">{t("loadFailed")}</span>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            {t("retry")}
          </Button>
        </div>
      ) : nothingAtAll ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
          <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <FileSignature className="size-5" aria-hidden />
          </div>
          <h2 className="text-base font-semibold text-foreground">{t("emptyTitle")}</h2>
          <p className="max-w-sm text-sm text-muted-foreground">{t("emptyBody")}</p>
          {canSend ? (
            <Link href="/sign/new" className={cn(buttonVariants({ size: "lg" }))}>
              <Plus aria-hidden />
              {t("emptyAction")}
            </Link>
          ) : null}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">{t("noMatch")}</p>
          <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
            {t("clearFilters")}
          </Button>
        </div>
      ) : (
        <div aria-busy={refreshing} className={cn("space-y-4 transition-opacity", refreshing && "opacity-60")}>
          <DocumentTable rows={rows} categories={categories} now={now} />
          <DocumentCards rows={rows} categories={categories} now={now} />
          <div className="flex flex-col items-center gap-2 pt-1">
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {t("showing", { shown: rows.length, total: Math.max(total, rows.length) })}
            </p>
            {hasMore ? (
              <Button type="button" variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t("loadMore")}
              </Button>
            ) : null}
            {loadMoreFailed ? (
              <p role="alert" className="text-xs text-destructive">
                {t("loadMoreFailed")}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
