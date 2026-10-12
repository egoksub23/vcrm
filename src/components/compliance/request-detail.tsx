"use client";

// ============================================================
// Compliance requests, one case (/compliance/[id]): the header with the clock, the step bar, and the panels (customer, answers, bank details, account
// standing, identity check, officer review, Head of Compliance sign-off, execution, files, links, timeline). Phone: stacked panels, the step bar sticks.
//
// What the browser holds: the case as /api/compliance/requests/[id] sent it (sensitive answers as masks) and, for at most two minutes, the bank details of
// this one case after a reveal. They are dropped when the two minutes pass, when the page goes to the background, when the person hides them, and when the
// screen closes. Opening the case and every reveal are recorded in the case's timeline by the server.
// ============================================================

import { ArrowLeft, Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { NoAccess } from "@/components/auth/no-access";
import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-auth";
import { notifyComplianceChanged } from "@/hooks/use-compliance-waiting";
import { useNow } from "@/hooks/use-now";
import { computeClock } from "@/lib/compliance/clock";
import type { RequestDetail } from "@/lib/compliance/types";

import { editRequest, getDetail, type ApiResult, type RevealResult } from "./api";
import {
  AnswersPanel,
  ClockPanel,
  CloseWithoutDecision,
  CustomerPanel,
  ExecutionPanel,
  FilesPanel,
  IdentityPanel,
  LinksPanel,
  NoticesPanel,
  REVEAL_MS,
  ReviewPanel,
  SensitivePanel,
  SignoffPanel,
  StandingPanel,
  TimelinePanel,
  useRevealTimer,
  type Act,
} from "./detail-panels";
import { errorKey, formatDay, typeLabel } from "./helpers";
import { ClockChip, ClockText, Notice, Person, StatusChip, StepBar, TypeChip } from "./parts";

const SELECT = "h-8 w-full max-w-xs rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function RequestDetailScreen({ id }: { id: string }) {
  const t = useTranslations("Compliance");
  const tErr = useTranslations("Compliance.errors");
  const locale = useLocale();
  const canMenu = useCapability("menu.compliance");
  const [d, setD] = useState<RequestDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<{ result: RevealResult; until: number } | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string | null }[]>([]);
  const now = useNow(revealed ? 1000 : 30_000);

  const load = useCallback(
    async () => {
      const res = await getDetail(id);
      if (!res.ok) {
        setLoadError(errorKey(res.code));
        return false;
      }
      setLoadError(null);
      setD(res.data);
      return true;
    },
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // who a case can be assigned to: the people the list route names
  useEffect(() => {
    void import("./api").then(({ getList }) => getList({}).then((r) => r.ok && setPeople(r.data.people)));
  }, []);

  // the bank details are hidden again when the page goes to the background or the screen closes
  const hide = useCallback(() => setRevealed(null), []);
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") hide();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      hide();
    };
  }, [hide]);
  useRevealTimer(now, revealed, hide);

  const act: Act = useCallback(
    async (fn: () => Promise<ApiResult<unknown>>) => {
      setBusy(true);
      setActionError(null);
      const res = await fn();
      if (!res.ok) {
        setActionError(errorKey(res.code));
        setBusy(false);
        return false;
      }
      await load();
      setBusy(false);
      // the sidebar's badge asks again (a case moved)
      notifyComplianceChanged();
      return true;
    },
    [load],
  );

  const clock = useMemo(
    () =>
      d
        ? computeClock(
            { status: d.status, receivedAt: d.receivedAt, targetDays: d.targetDays, hardStopDays: d.hardStopDays, targetDueAt: d.targetDueAt, hardStopAt: d.hardStopAt, pausedAt: d.pausedAt, completedAt: d.completedAt, closedAt: d.closedAt },
            now,
          )
        : null,
    [d, now],
  );

  if (!canMenu) return <NoAccess />;

  if (loadError && !d) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-3 p-4 md:p-6">
        <Link href="/compliance" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="size-4" aria-hidden />
          {t("back")}
        </Link>
        <Notice tone="danger">{tErr(loadError)}</Notice>
        <Button variant="outline" size="sm" onClick={() => void load()}>{t("retry")}</Button>
      </div>
    );
  }
  if (!d || !clock) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </div>
    );
  }

  const canAssign = (d.viewer.canReview || d.viewer.canApprove) && d.status !== "closed";
  const props = { d, act, busy, now };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-6">
      <Link href="/compliance" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <ArrowLeft className="size-4" aria-hidden />
        {t("back")}
      </Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-xl font-semibold text-foreground">{d.reference}</h1>
          <TypeChip request={d} />
          <StatusChip status={d.status} />
          {d.isTest ? <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("test")}</span> : null}
        </div>
        <p className="text-sm text-foreground">
          {d.customerName} · {typeLabel(d, locale)} · {t("receivedOn", { date: formatDay(d.receivedAt, locale) })}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <ClockChip view={clock} />
          <span className="text-muted-foreground"><ClockText view={clock} /></span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="cmp-assignee-d" className="text-muted-foreground">{t("columns.assignee")}</label>
          {canAssign ? (
            <select id="cmp-assignee-d" className={SELECT} value={d.assignedTo?.id ?? ""} disabled={busy} onChange={(e) => void act(() => editRequest(d.id, { assignedTo: e.target.value || null }))}>
              <option value="">{t("unassigned")}</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name ?? t("formerMember")}</option>
              ))}
              {d.assignedTo && !people.some((p) => p.id === d.assignedTo?.id) ? <option value={d.assignedTo.id}>{d.assignedTo.name ?? t("formerMember")}</option> : null}
            </select>
          ) : (
            <Person person={d.assignedTo} />
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("retention", { date: formatDay(d.retentionUntil, locale) })}</p>
      </header>

      <div className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-1 backdrop-blur">
        <StepBar status={d.status} />
      </div>

      {actionError ? (
        <Notice tone="danger">{tErr(actionError)}</Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <CustomerPanel {...props} />
          <AnswersPanel {...props} />
          <SensitivePanel {...props} revealed={revealed} onRevealed={(r) => setRevealed({ result: r, until: Date.now() + Math.min(REVEAL_MS, r.expiresInSeconds * 1000) })} onHide={hide} />
          <StandingPanel {...props} />
          <FilesPanel {...props} />
          <LinksPanel {...props} />
        </div>
        <div className="space-y-4">
          <IdentityPanel {...props} />
          <ReviewPanel {...props} />
          <SignoffPanel {...props} />
          <ClockPanel {...props} />
          <ExecutionPanel {...props} />
          <NoticesPanel {...props} />
          <CloseWithoutDecision {...props} />
        </div>
      </div>

      <TimelinePanel {...props} />
    </div>
  );
}
