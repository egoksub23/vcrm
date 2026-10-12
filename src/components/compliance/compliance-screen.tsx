"use client";

// ============================================================
// Compliance requests, the list (/compliance): the counts of what needs doing, the filters, the cases with their clock, and New request.
// What the browser holds is what /api/compliance/requests sent: no answers and no sensitive value (the detail shows masks). Nothing is kept in the
// browser except the filters in memory.
// ============================================================

import { BarChart3, ClipboardCheck, Plus, Search, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { NoAccess } from "@/components/auth/no-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCapability } from "@/hooks/use-auth";
import { useNow } from "@/hooks/use-now";
import type { RequestList, RequestTypeRow } from "@/lib/compliance/types";
import { REQUEST_STATUSES } from "@/lib/compliance/types";

import { getList, getTypes, type ListQuery } from "./api";
import { EMPTY_FILTERS, HEADER_CHIPS, chipActive, errorKey, formatDay, hasFilters, toggleChip, typeLabel, type Filters, type HeaderChipKey } from "./helpers";
import { NewRequest } from "./new-request";
import { ClockCell, CountButton, Notice, Person, StatusChip, TypeChip } from "./parts";

const SELECT = "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const CHIP_TONE: Record<HeaderChipKey, "neutral" | "warn" | "danger"> = { needsIdentityCheck: "neutral", inReview: "neutral", awaitingSignoff: "neutral", executing: "neutral", pastTarget: "warn", nearStop: "danger", breached: "danger" };
const PAGE_SIZE = 25;

export function ComplianceScreen() {
  const t = useTranslations("Compliance");
  const tErr = useTranslations("Compliance.errors");
  const locale = useLocale();
  const router = useRouter();
  const canMenu = useCapability("menu.compliance");
  const now = useNow(60_000);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // a link from a conversation or a ticket ("Compliance request CMP-... raised") opens the list searched for that reference
  const [draftQ, setDraftQ] = useState(() => (typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get("q") ?? "").slice(0, 100)));
  const [list, setList] = useState<RequestList | null>(null);
  const [types, setTypes] = useState<RequestTypeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (f: Filters) => {
    const mine = ++seq.current;
    setLoading(true);
    const q: ListQuery = { type: f.type, status: f.status, due: f.due, assignee: f.assignee, mine: f.mine, q: f.q, from: f.from, to: f.to, page: f.page };
    const res = await getList(q);
    if (mine !== seq.current) return;
    setLoading(false);
    if (!res.ok) {
      setError(errorKey(res.code));
      return;
    }
    setError(null);
    setList(res.data);
  }, []);

  useEffect(() => {
    // load-on-change fetch whose result sets state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(filters);
  }, [filters, load]);

  useEffect(() => {
    void getTypes().then((r) => {
      if (r.ok) setTypes(r.data.types);
    });
  }, []);

  // the search box applies after a short pause, so each key is not a request
  useEffect(() => {
    const id = setTimeout(() => setFilters((f) => (f.q === draftQ ? f : { ...f, q: draftQ, page: 1 })), 350);
    return () => clearTimeout(id);
  }, [draftQ]);

  if (!canMenu) return <NoAccess />;

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  const clear = () => {
    setDraftQ("");
    setFilters(EMPTY_FILTERS);
  };
  const viewer = list?.viewer;
  const canCreate = !!viewer && (viewer.canReview || viewer.canApprove);
  const pages = list ? Math.max(1, Math.ceil(list.total / PAGE_SIZE)) : 1;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="size-5 text-muted-foreground" aria-hidden />
          <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canCreate ? (
            <Link href="/compliance/reports" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-muted">
              <BarChart3 className="size-4" aria-hidden />
              {t("reportsLink")}
            </Link>
          ) : null}
          {canCreate ? (
            <Button onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
              <Plus className="size-4" aria-hidden />
              {t("newRequest")}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{t("intro")}</p>

      {creating ? (
        <NewRequest
          types={types}
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            router.push(`/compliance/${id}`);
          }}
        />
      ) : null}

      {error ? <Notice tone="danger">{tErr(error)}</Notice> : null}

      <section aria-label={t("counts.label")} className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {HEADER_CHIPS.map((chip) => (
          <CountButton key={chip.key} label={t(`counts.${chip.key}`)} count={list?.counts[chip.key] ?? 0} tone={CHIP_TONE[chip.key]} active={chipActive(chip, filters)} onClick={() => setFilters(toggleChip(chip, filters))} />
        ))}
      </section>

      <form role="search" aria-label={t("filters.label")} onSubmit={(e) => e.preventDefault()} className="grid gap-2 rounded-xl border border-border bg-card p-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2">
          <label htmlFor="cmp-q" className="sr-only">
            {t("filters.search")}
          </label>
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input id="cmp-q" value={draftQ} onChange={(e) => setDraftQ(e.target.value)} placeholder={t("filters.searchPlaceholder")} className="pl-8" autoComplete="off" maxLength={100} />
        </div>
        <div>
          <label htmlFor="cmp-type" className="sr-only">
            {t("filters.type")}
          </label>
          <select id="cmp-type" className={SELECT} value={filters.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="">{t("filters.allTypes")}</option>
            {(list?.types ?? []).map((x) => (
              <option key={x.key} value={x.key}>
                {typeLabel({ typeLabel: x.label, typeLabelL10n: x.labelL10n }, locale)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="cmp-status" className="sr-only">
            {t("filters.status")}
          </label>
          <select id="cmp-status" className={SELECT} value={filters.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">{t("filters.allStatuses")}</option>
            {REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
            {filters.status.includes(",") ? <option value={filters.status}>{filters.status.split(",").map((s) => t(`status.${s}`)).join(" + ")}</option> : null}
          </select>
        </div>
        <div>
          <label htmlFor="cmp-due" className="sr-only">
            {t("filters.due")}
          </label>
          <select id="cmp-due" className={SELECT} value={filters.due} onChange={(e) => set({ due: e.target.value })}>
            {(["all", "on_track", "target_passed", "near_stop", "breached", "paused", "done"] as const).map((d) => (
              <option key={d} value={d}>
                {d === "all" ? t("filters.anyClock") : t(`clock.state.${d}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="cmp-assignee" className="sr-only">
            {t("filters.assignee")}
          </label>
          <select id="cmp-assignee" className={SELECT} value={filters.assignee} onChange={(e) => set({ assignee: e.target.value })}>
            <option value="">{t("filters.anyone")}</option>
            <option value="none">{t("unassigned")}</option>
            {(list?.people ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ?? t("formerMember")}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="cmp-from" className="text-xs text-muted-foreground">
            {t("filters.from")}
          </label>
          <Input id="cmp-from" type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} />
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="cmp-to" className="text-xs text-muted-foreground">
            {t("filters.to")}
          </label>
          <Input id="cmp-to" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-foreground">
            <input type="checkbox" checked={filters.mine} onChange={(e) => set({ mine: e.target.checked })} className="size-4 accent-[var(--primary)]" />
            {t("filters.mine")}
          </label>
          {hasFilters(filters) ? (
            <Button type="button" variant="ghost" size="sm" onClick={clear}>
              <X className="size-3.5" aria-hidden />
              {t("filters.clear")}
            </Button>
          ) : null}
        </div>
      </form>

      <div aria-live="polite" className="text-xs text-muted-foreground">
        {loading ? t("loading") : list ? t("showing", { count: list.total }) : ""}
      </div>

      {list && list.rows.length === 0 && !loading ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="font-medium text-foreground">{hasFilters(filters) ? t("empty.filteredTitle") : t("empty.title")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{hasFilters(filters) ? t("empty.filteredBody") : t("empty.body")}</p>
          {hasFilters(filters) ? (
            <Button variant="outline" size="sm" className="mt-3" onClick={clear}>
              {t("filters.clear")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {list && list.rows.length > 0 ? (
        <>
          {/* a wide screen: a table */}
          <div className="hidden overflow-x-auto rounded-xl border border-border bg-card md:block">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">{t("columns.reference")}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t("columns.customer")}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t("columns.status")}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t("columns.clock")}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t("columns.assignee")}</th>
                  <th scope="col" className="px-3 py-2 font-medium">{t("columns.received")}</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="px-3 py-2 align-top">
                      <Link href={`/compliance/${r.id}`} className="font-mono text-xs font-medium text-primary underline-offset-2 hover:underline">
                        {r.reference}
                      </Link>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <TypeChip request={r} />
                        {r.isTest ? <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("test")}</span> : null}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium text-foreground">{r.customerName}</div>
                      <div className="text-xs text-muted-foreground">{r.customerPhone ?? r.customerEmail ?? ""}</div>
                    </td>
                    <td className="px-3 py-2 align-top"><StatusChip status={r.status} /></td>
                    <td className="px-3 py-2 align-top"><ClockCell request={r} now={now} /></td>
                    <td className="px-3 py-2 align-top"><Person person={r.assignedTo} /></td>
                    <td className="px-3 py-2 align-top whitespace-nowrap text-muted-foreground">{formatDay(r.receivedAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* a phone: cards */}
          <ul className="space-y-2 md:hidden">
            {list.rows.map((r) => (
              <li key={r.id} className="rounded-xl border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/compliance/${r.id}`} className="font-mono text-xs font-medium text-primary underline-offset-2 hover:underline">
                    {r.reference}
                  </Link>
                  <StatusChip status={r.status} />
                </div>
                <div className="mt-1 font-medium text-foreground">{r.customerName}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1"><TypeChip request={r} /></div>
                <div className="mt-2"><ClockCell request={r} now={now} /></div>
                <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                  <span><Person person={r.assignedTo} /></span>
                  <span>{formatDay(r.receivedAt, locale)}</span>
                </div>
              </li>
            ))}
          </ul>

          {pages > 1 ? (
            <nav aria-label={t("pager.label")} className="flex items-center justify-between gap-2 text-sm">
              <Button variant="outline" size="sm" disabled={filters.page <= 1} onClick={() => set({ page: filters.page - 1 })}>
                {t("pager.previous")}
              </Button>
              <span className="text-muted-foreground">{t("pager.page", { page: filters.page, pages })}</span>
              <Button variant="outline" size="sm" disabled={filters.page >= pages} onClick={() => set({ page: filters.page + 1 })}>
                {t("pager.next")}
              </Button>
            </nav>
          ) : null}
        </>
      ) : null}

      <p className="text-xs text-muted-foreground">{t("footer")}</p>
    </div>
  );
}
