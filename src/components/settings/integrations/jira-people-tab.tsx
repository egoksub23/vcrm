"use client";

// Settings > Integrations > Jira > People. Which Jira user is each workspace
// member (comments carry their name, assignment needs the match). Presentational:
// the container searches Jira and saves the picks.

import { useEffect, useState } from "react";
import { Loader2, UserRoundCheck, Wand2, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { JiraMemberRow, JiraPeopleData, JiraUserHit } from "./jira-api";
import { JiraCard, LoadProblem, LoadingLine } from "./jira-form-parts";
import { SettingsChip } from "../settings-chip";

export interface JiraPeopleTabProps {
  /** null while loading. */
  data: JiraPeopleData | null;
  error: string | null;
  currentUserId: string | null;
  autoMatching: boolean;
  /** The member whose match is being saved. */
  busyUserId: string | null;
  onAutoMatch: () => void;
  onPick: (userId: string, hit: JiraUserHit) => void;
  onClear: (userId: string) => void;
  /** Jira users for a query (>= 2 characters); null when the lookup failed. */
  onSearch: (query: string) => Promise<JiraUserHit[] | null>;
  onRetry: () => void;
}

export function JiraPeopleTab({
  data,
  error,
  currentUserId,
  autoMatching,
  busyUserId,
  onAutoMatch,
  onPick,
  onClear,
  onSearch,
  onRetry,
}: JiraPeopleTabProps) {
  const t = useTranslations("Settings.jira.people");
  const [pickingFor, setPickingFor] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <JiraCard title={t("explain.title")}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{t("explain.email")}</li>
          <li>{t("explain.unmatched")}</li>
          <li>{t("explain.own")}</li>
        </ul>
      </JiraCard>

      {error ? (
        <LoadProblem message={error} onRetry={onRetry} />
      ) : data === null ? (
        <LoadingLine />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <p className="text-sm text-muted-foreground">
              {t("summary", { matched: data.members.filter((m) => m.match).length, total: data.members.length })}
            </p>
            {data.canManageAll ? (
              <Button variant="outline" size="sm" onClick={onAutoMatch} disabled={autoMatching}>
                {autoMatching ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
                {t("autoMatch")}
              </Button>
            ) : null}
          </div>
          {data.members.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.members.map((m) => (
                <MemberRow
                  key={m.userId}
                  member={m}
                  editable={data.canManageAll || m.userId === currentUserId}
                  own={m.userId === currentUserId}
                  busy={busyUserId === m.userId}
                  picking={pickingFor === m.userId}
                  onStartPick={() => setPickingFor(m.userId)}
                  onStopPick={() => setPickingFor(null)}
                  onPick={(hit) => {
                    setPickingFor(null);
                    onPick(m.userId, hit);
                  }}
                  onClear={() => onClear(m.userId)}
                  onSearch={onSearch}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function MemberRow({
  member,
  editable,
  own,
  busy,
  picking,
  onStartPick,
  onStopPick,
  onPick,
  onClear,
  onSearch,
}: {
  member: JiraMemberRow;
  editable: boolean;
  own: boolean;
  busy: boolean;
  picking: boolean;
  onStartPick: () => void;
  onStopPick: () => void;
  onPick: (hit: JiraUserHit) => void;
  onClear: () => void;
  onSearch: JiraPeopleTabProps["onSearch"];
}) {
  const t = useTranslations("Settings.jira.people");
  const match = member.match;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="truncate text-sm font-medium text-foreground">
            {member.name || t("unnamed")}
            {own ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{t("you")}</span> : null}
          </p>
          {member.email ? <p className="truncate text-xs text-muted-foreground">{member.email}</p> : null}
        </div>
        <div className="min-w-0 flex-1 basis-48">
          {match ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <SettingsChip variant="ok">
                <UserRoundCheck aria-hidden />
                <span className="max-w-48 truncate">{match.displayName || match.jiraAccountId}</span>
              </SettingsChip>
              {match.method === "email" || match.method === "manual" ? (
                <span className="text-xs text-muted-foreground">{t(`method.${match.method}`)}</span>
              ) : null}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">{t("notMatched")}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {busy ? <Loader2 className="size-4 animate-spin text-primary" aria-label={t("saving")} /> : null}
          <Button variant="outline" size="sm" onClick={picking ? onStopPick : onStartPick} disabled={!editable || busy}>
            {picking ? t("cancel") : match ? t("change") : t("pick")}
          </Button>
          {match ? (
            <Button variant="ghost" size="sm" onClick={onClear} disabled={!editable || busy}>
              <X className="size-4" />
              {t("clear")}
            </Button>
          ) : null}
        </div>
      </div>
      {picking ? <JiraUserPicker onSearch={onSearch} onPick={onPick} /> : null}
    </li>
  );
}

/** Type two characters, pick a Jira user. The lookup waits for a pause in typing. */
function JiraUserPicker({
  onSearch,
  onPick,
}: {
  onSearch: JiraPeopleTabProps["onSearch"];
  onPick: (hit: JiraUserHit) => void;
}) {
  const t = useTranslations("Settings.jira.people.picker");
  const [q, setQ] = useState("");
  const [result, setResult] = useState<{ query: string; users: JiraUserHit[] | null } | null>(null);

  const query = q.trim();
  const tooShort = query.length < 2;

  useEffect(() => {
    if (query.length < 2) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      const users = await onSearch(query);
      if (!cancelled) setResult({ query, users });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, onSearch]);

  const current = !tooShort && result?.query === query ? result : null;

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <Input
        autoFocus
        value={q}
        maxLength={100}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("placeholder")}
        aria-label={t("placeholder")}
      />
      {tooShort ? (
        <p className="text-xs text-muted-foreground">{t("minChars")}</p>
      ) : current === null ? (
        <LoadingLine label={t("searching")} />
      ) : current.users === null ? (
        <p className="text-xs text-destructive">{t("failed")}</p>
      ) : current.users.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-card">
          {current.users.map((u) => (
            <li key={u.accountId}>
              <button
                type="button"
                onClick={() => onPick(u)}
                className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-muted/50"
              >
                <span className="text-sm font-medium text-foreground">{u.displayName || u.accountId}</span>
                {u.email ? <span className="text-xs text-muted-foreground">{u.email}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
