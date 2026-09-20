"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, X } from "lucide-react";

import type { JiraApiError, JiraUserHit } from "@/hooks/use-ticket-jira";
import { errorKeyOf, loose, retrySeconds } from "@/lib/tickets/jira-ui";
import { cn } from "@/lib/utils";

/** Native controls styled like the app's inputs: they work in a dialog without a portal. */
export const JIRA_INPUT_CLASS =
  "h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-60";
export const JIRA_TEXTAREA_CLASS =
  "w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * A friendly, translated message for a failed Jira call: the code's sentence,
 * plus what Jira said (jira_rejected) or which fields were named. Jira's own
 * text is untrusted and rendered as plain text.
 */
export function JiraErrorNotice({ error, className }: { error: JiraApiError; className?: string }) {
  const t = useTranslations("Jira.errors");
  const key = errorKeyOf(error.code);
  const lines = [...(error.messages ?? []), ...Object.entries(error.fieldErrors ?? {}).map(([f, m]) => `${f}: ${m}`)].slice(0, 8);
  const fields = (error.fields ?? []).slice(0, 8);
  return (
    <div
      role="alert"
      className={cn("space-y-1 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-xs text-red-800 dark:text-red-200", className)}
    >
      <p className="font-medium">{loose(t)(key, { seconds: retrySeconds(error.retryAfterSeconds) })}</p>
      {lines.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4">
          {lines.map((l, i) => (
            <li key={i} className="break-words">
              {l}
            </li>
          ))}
        </ul>
      ) : null}
      {fields.length > 0 ? <p className="break-words">{fields.join(", ")}</p> : null}
    </div>
  );
}

/**
 * Search Jira users (2+ characters, debounced) and pick one. Results are an
 * inline list, not a popup, so it works inside a dialog. `onSearch` is
 * supplied by the caller (the picker fetches nothing itself).
 */
export function JiraUserPicker({
  value,
  onChange,
  onSearch,
  placeholder,
  inputId,
  disabled,
}: {
  value: JiraUserHit | null;
  onChange: (next: JiraUserHit | null) => void;
  onSearch: (query: string) => Promise<JiraUserHit[]>;
  placeholder?: string;
  inputId?: string;
  disabled?: boolean;
}) {
  const t = useTranslations("Jira.picker");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<JiraUserHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      void onSearch(q).then((rows) => {
        if (cancelled) return;
        setResults(rows.slice(0, 8));
        setSearching(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, onSearch]);

  if (value) {
    return (
      <div className="flex h-8 items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 text-[13px]">
        <span className="min-w-0 truncate">{value.displayName}</span>
        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={disabled}
          aria-label={t("clear")}
          className="rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    );
  }

  const q = query.trim();
  return (
    <div className="space-y-1">
      <input
        id={inputId}
        type="search"
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder ?? t("placeholder")}
        autoComplete="off"
        className={JIRA_INPUT_CLASS}
      />
      {q.length >= 2 ? (
        <ul className="max-h-40 overflow-y-auto rounded-lg border border-border bg-background">
          {searching ? (
            <li className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("searching")}
            </li>
          ) : results.length === 0 ? (
            <li className="px-2.5 py-1.5 text-xs text-muted-foreground">{t("none")}</li>
          ) : (
            results.map((u) => (
              <li key={u.accountId}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(u);
                    setQuery("");
                  }}
                  className="flex w-full flex-col items-start px-2.5 py-1.5 text-left text-[13px] hover:bg-muted"
                >
                  <span className="max-w-full truncate">{u.displayName}</span>
                  {u.email ? <span className="max-w-full truncate text-[11px] text-muted-foreground">{u.email}</span> : null}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
