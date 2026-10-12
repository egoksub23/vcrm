"use client";

// ============================================================
// KYC review, the Access log tab (administrators and owners only). Who looked up which friend id, listed validations, opened an image or revealed a
// value, and how it ended. Never a key, an image or a field value. Filters: person, friend id, action, date. A CSV export of the same filters, at most
// 5,000 rows. The log is append-only and is not trimmed.
// ============================================================

import { Download } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { FRIEND_ID_RE, KYC_ACTIONS, type KycAccessRow } from "@/lib/kyc/types";

import { accessLogExportUrl, getAccessLog, type LogFilters } from "./api";
import { exactTime } from "./helpers";
import { ErrorPanel } from "./parts";

const SELECT = "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export const EMPTY_FILTERS: LogFilters = { userId: "", friendId: "", action: "", from: "", to: "" };

export function AccessLogTable({ rows }: { rows: readonly KycAccessRow[] }) {
  const t = useTranslations("Kyc.log");
  const locale = useLocale();
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full min-w-[640px] text-left text-sm">
        <caption className="sr-only">{t("title")}</caption>
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">{t("columns.time")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("columns.person")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("columns.action")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("columns.friend")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("columns.validation")}</th>
            <th scope="col" className="px-3 py-2 font-medium">{t("columns.outcome")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 whitespace-nowrap">
                <time dateTime={r.createdAt}>{exactTime(r.createdAt, locale)}</time>
              </td>
              <td className="px-3 py-2">{r.userName ?? <span className="text-muted-foreground">{t("formerMember")}</span>}</td>
              <td className="px-3 py-2">{t(`actions.${r.action}`)}</td>
              <td className="px-3 py-2 font-mono text-xs break-all">{r.friendId ?? "—"}</td>
              <td className="px-3 py-2 font-mono text-xs break-all">{r.validationId ?? "—"}</td>
              <td className="px-3 py-2">
                <span className={cn("font-medium", r.outcome === "ok" ? "text-foreground" : "text-destructive")}>{t(`outcomes.${r.outcome}`)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AccessLogPanel() {
  const t = useTranslations("Kyc.log");
  const [draft, setDraft] = useState<LogFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<LogFilters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<KycAccessRow[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [friendInvalid, setFriendInvalid] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (filters: LogFilters, before?: string) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    const res = await getAccessLog(filters, before);
    if (mine !== seq.current) return;
    setLoading(false);
    if (!res.ok) {
      setError(res.code);
      return;
    }
    setRows((prev) => (before ? [...prev, ...res.data.rows] : res.data.rows));
    setPeople(res.data.people);
    setHasMore(res.data.hasMore);
  }, []);

  useEffect(() => {
    // first page on arrival: a fetch whose result sets state (the usual load-on-mount pattern)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(EMPTY_FILTERS);
  }, [load]);

  const apply = () => {
    const friend = draft.friendId.trim();
    if (friend && !FRIEND_ID_RE.test(friend)) {
      setFriendInvalid(true);
      return;
    }
    setFriendInvalid(false);
    setApplied(draft);
    void load(draft);
  };
  const reset = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setFriendInvalid(false);
    void load(EMPTY_FILTERS);
  };

  return (
    <section aria-labelledby="kyc-log-title" className="space-y-3">
      <div>
        <h2 id="kyc-log-title" className="font-medium text-foreground">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>

      <form
        className="grid gap-3 rounded-xl border border-border bg-card p-3 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div>
          <label htmlFor="kyc-log-person" className="mb-1 block text-xs text-muted-foreground">{t("person")}</label>
          <select id="kyc-log-person" className={SELECT} value={draft.userId} onChange={(e) => setDraft({ ...draft, userId: e.target.value })}>
            <option value="">{t("allPeople")}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="kyc-log-friend" className="mb-1 block text-xs text-muted-foreground">{t("friendId")}</label>
          <Input id="kyc-log-friend" value={draft.friendId} onChange={(e) => setDraft({ ...draft, friendId: e.target.value })} aria-invalid={friendInvalid || undefined} aria-describedby={friendInvalid ? "kyc-log-friend-error" : undefined} autoComplete="off" spellCheck={false} />
          {friendInvalid ? <p id="kyc-log-friend-error" className="mt-1 text-xs text-destructive">{t("friendInvalid")}</p> : null}
        </div>
        <div>
          <label htmlFor="kyc-log-action" className="mb-1 block text-xs text-muted-foreground">{t("action")}</label>
          <select id="kyc-log-action" className={SELECT} value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
            <option value="">{t("allActions")}</option>
            {KYC_ACTIONS.map((a) => (
              <option key={a} value={a}>{t(`actions.${a}`)}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="kyc-log-from" className="mb-1 block text-xs text-muted-foreground">{t("from")}</label>
          <Input id="kyc-log-from" type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </div>
        <div>
          <label htmlFor="kyc-log-to" className="mb-1 block text-xs text-muted-foreground">{t("to")}</label>
          <Input id="kyc-log-to" type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-5">
          <Button type="submit" size="sm" disabled={loading}>{t("apply")}</Button>
          <Button type="button" variant="outline" size="sm" onClick={reset} disabled={loading}>{t("reset")}</Button>
          <a href={accessLogExportUrl(applied)} download className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-auto")}>
            <Download aria-hidden />
            {t("export")}
          </a>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-5">{t("exportNote")}</p>
      </form>

      <div aria-live="polite">
        {error ? <ErrorPanel code={error} isAdmin onRetry={() => void load(applied)} /> : null}
        {!error && !loading && rows.length === 0 ? <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{t("empty")}</p> : null}
        {loading && rows.length === 0 ? <p className="p-2 text-sm text-muted-foreground">{t("loading")}</p> : null}
      </div>
      {rows.length > 0 ? <AccessLogTable rows={rows} /> : null}
      {hasMore ? (
        <div>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(applied, rows[rows.length - 1]?.createdAt)}>
            {t("loadMore")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
