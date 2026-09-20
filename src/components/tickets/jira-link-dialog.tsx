"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { jiraApi, type JiraApiError, type JiraApiResult, type JiraIssueHit } from "@/hooks/use-ticket-jira";
import type { TicketJiraLinkRow } from "@/lib/jira/types";
import { categoryTone, extractIssueKey } from "@/lib/tickets/jira-ui";
import { cn } from "@/lib/utils";
import { JIRA_INPUT_CLASS, JiraErrorNotice } from "./jira-form-parts";

export interface JiraLinkFormProps {
  query: string;
  onQueryChange: (next: string) => void;
  /** Search results for the current text; null until the first search returns. */
  results: JiraIssueHit[] | null;
  searching: boolean;
  searchError: JiraApiError | null;
  /** Keys already linked to this ticket (shown as such, not selectable). */
  linkedKeys: string[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  linking: boolean;
  linkError: JiraApiError | null;
  onLink: () => void;
  onCancel: () => void;
}

/**
 * The body of the "Link existing issue" dialog: paste a key or an issue URL,
 * or search by text, pick a result, link it. Presentational.
 */
export function JiraLinkForm({
  query,
  onQueryChange,
  results,
  searching,
  searchError,
  linkedKeys,
  selectedKey,
  onSelect,
  linking,
  linkError,
  onLink,
  onCancel,
}: JiraLinkFormProps) {
  const t = useTranslations("Jira.link");
  const inputId = useId();
  const pasted = extractIssueKey(query);
  const target = selectedKey ?? pasted;
  const alreadyHere = !!target && linkedKeys.some((k) => k.toUpperCase() === target.toUpperCase());

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={inputId} className="text-xs font-medium text-foreground">
          {t("inputLabel")}
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            id={inputId}
            type="text"
            value={query}
            autoFocus
            disabled={linking}
            onChange={(e) => {
              onQueryChange(e.target.value);
              onSelect(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && target && !alreadyHere && !linking) {
                e.preventDefault();
                onLink();
              }
            }}
            placeholder={t("inputPlaceholder")}
            autoComplete="off"
            className={cn(JIRA_INPUT_CLASS, "pl-8")}
          />
        </div>
        {pasted && !selectedKey ? <p className="text-[11px] text-muted-foreground">{t("willLink", { key: pasted })}</p> : null}
      </div>

      {searchError ? <JiraErrorNotice error={searchError} /> : null}

      {searching ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("searching")}
        </p>
      ) : results !== null && query.trim().length >= 2 && !searchError ? (
        results.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("noResults")}</p>
        ) : (
          <ul aria-label={t("resultsLabel")} className="max-h-56 space-y-1 overflow-y-auto">
            {results.map((r) => {
              const linked = linkedKeys.some((k) => k.toUpperCase() === r.key.toUpperCase());
              const selected = selectedKey === r.key;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    disabled={linked || linking}
                    aria-pressed={selected}
                    onClick={() => onSelect(selected ? null : r.key)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted",
                    )}
                  >
                    <span className="font-mono font-semibold text-primary">{r.key}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-foreground">{r.summary}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{[r.project, r.type].filter(Boolean).join(" · ")}</span>
                    </span>
                    {linked ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">{t("alreadyLinkedHere")}</span>
                    ) : r.status ? (
                      <span
                        className={cn(
                          "max-w-28 shrink-0 truncate rounded-[4px] px-1.5 py-0.5 text-[10px] leading-none font-bold tracking-wide uppercase",
                          categoryTone(r.category),
                        )}
                      >
                        {r.status}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}

      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
        <li>{t("noteShared")}</li>
        <li>{t("noteComments")}</li>
      </ul>

      {linkError ? <JiraErrorNotice error={linkError} /> : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={linking}>
          {t("cancel")}
        </Button>
        <Button onClick={onLink} disabled={!target || alreadyHere || linking}>
          {linking ? <Loader2 className="size-4 animate-spin" /> : null}
          {linking ? t("linking") : target ? t("linkKey", { key: target }) : t("link")}
        </Button>
      </div>
    </div>
  );
}

function JiraLinkContainer({
  ticketId,
  linkedKeys,
  onLinked,
  onCancel,
}: {
  ticketId: string;
  linkedKeys: string[];
  onLinked: (link: TicketJiraLinkRow) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [searched, setSearched] = useState<{ q: string; result: JiraApiResult<{ issues: JiraIssueHit[] }> } | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<JiraApiError | null>(null);

  // A pasted URL or key is searched by its key so the result shows the summary.
  const pasted = extractIssueKey(query);
  const q = (pasted ?? query).trim();
  const wantsSearch = q.length >= 2;

  useEffect(() => {
    if (!wantsSearch) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      void jiraApi.searchIssues(q).then((result) => {
        if (!cancelled) setSearched({ q, result });
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, wantsSearch]);

  const current = wantsSearch && searched && searched.q === q ? searched.result : null;

  const link = async () => {
    const reference = selectedKey ?? pasted;
    if (!reference || linking) return;
    setLinking(true);
    setLinkError(null);
    const r = await jiraApi.linkIssue(ticketId, reference);
    setLinking(false);
    if (r.ok) onLinked(r.data.link);
    else setLinkError(r);
  };

  return (
    <JiraLinkForm
      query={query}
      onQueryChange={(next) => {
        setQuery(next);
        setLinkError(null);
      }}
      results={current && current.ok ? current.data.issues : null}
      searching={wantsSearch && !current}
      searchError={current && !current.ok ? current : null}
      linkedKeys={linkedKeys}
      selectedKey={selectedKey}
      onSelect={setSelectedKey}
      linking={linking}
      linkError={linkError}
      onLink={() => void link()}
      onCancel={onCancel}
    />
  );
}

/** "Link existing issue": paste a key or URL, or search, pick, link. */
export function JiraLinkDialog({
  open,
  onOpenChange,
  ticketId,
  linkedKeys,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  linkedKeys: string[];
  onLinked: (link: TicketJiraLinkRow) => void;
}) {
  const t = useTranslations("Jira.link");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <JiraLinkContainer ticketId={ticketId} linkedKeys={linkedKeys} onLinked={onLinked} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
