"use client";

import { useTranslations } from "next-intl";
import { MessageCircle, CheckCircle2, Clock, Timer, Send, UserPlus, Users2, Trophy, Radio, TrendingUp, Ticket as TicketIcon, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useAccountMembers } from "@/hooks/use-account-members";
import { formatDuration } from "@/lib/sla/display";
import { MetricCard } from "@/components/dashboard/metric-card";
import { BarChart } from "@/components/tremor/bar-chart";
import type { DateRange } from "@/lib/reports/date-utils";
import {
  loadConversationsReport,
  loadResponsesReport,
  loadResolutionsReport,
  loadMessagesReport,
  loadContactsReport,
  loadAssignmentsReport,
  loadLeaderboardReport,
  loadUsersReport,
  loadLifecycleReport,
  loadBroadcastsReport,
  loadTicketsReport,
  loadTicketSlaReport,
  slaCompliancePct,
  LIFECYCLE_STAGES,
  type OverviewMetric,
  type SlaBreakdownRow,
  type SlaCounts,
  type TicketBreakdownRow,
  type TicketResolutionRow,
} from "@/lib/reports/queries";
import { useReportData, formatMinutes, formatPercent } from "./report-hooks";

interface PanelProps {
  accountId: string | null;
  range: DateRange;
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-80 items-center justify-center rounded-xl border border-border bg-card text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex h-80 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 text-sm text-destructive">
      {message}
    </div>
  );
}

/** delta.sign for MetricCard — `invert` flips the color/arrow meaning
 *  for a "lower is better" metric (response/resolution time), where a
 *  positive percentChange (slower) should read as bad (down/red), not
 *  good (up/green). */
function deltaFor(
  metric: OverviewMetric,
  vsPreviousPeriod: string,
  invert = false,
): { sign: number; label: string } {
  const pct = metric.percentChange;
  const sign = pct === null ? 0 : invert ? -Math.sign(pct) : Math.sign(pct);
  return { sign, label: `${formatPercent(pct)} ${vsPreviousPeriod}` };
}

export function ConversationsReportPanel({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.conversations");
  const tShared = useTranslations("Reports");
  const { data, loading, error } = useReportData(loadConversationsReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <MetricCard
          title={t("opened")}
          value={String(data.opened.current)}
          icon={MessageCircle}
          delta={deltaFor(data.opened, tShared("vsPreviousPeriod"))}
        />
        <MetricCard
          title={t("closed")}
          value={String(data.closed.current)}
          icon={CheckCircle2}
          delta={deltaFor(data.closed, tShared("vsPreviousPeriod"))}
        />
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="mb-4 text-sm font-medium text-foreground">{t("chartTitle")}</p>
        <BarChart
          data={data.series}
          index="day"
          categories={["opened", "closed"]}
          colors={["blue", "emerald"]}
          className="h-72"
        />
      </div>
    </div>
  );
}

export function ResponsesReportPanel({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.responses");
  const tShared = useTranslations("Reports");
  const { data, loading, error } = useReportData(loadResponsesReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <MetricCard
          title={t("avgFirstResponse")}
          value={formatMinutes(data.avgMinutes.current)}
          icon={Clock}
          delta={deltaFor(data.avgMinutes, tShared("vsPreviousPeriod"), true)}
        />
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="mb-4 text-sm font-medium text-foreground">{t("chartTitle")}</p>
        <BarChart
          data={data.series.map((s) => ({ day: s.day, avgMinutes: s.avgMinutes ?? 0 }))}
          index="day"
          categories={["avgMinutes"]}
          colors={["amber"]}
          valueFormatter={(v) => formatMinutes(v)}
          className="h-72"
        />
      </div>
    </div>
  );
}

export function ResolutionsReportPanel({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.resolutions");
  const tShared = useTranslations("Reports");
  const { data, loading, error } = useReportData(loadResolutionsReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {t("approximateNotice")}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <MetricCard
          title={t("avgResolution")}
          value={formatMinutes(data.avgMinutes.current)}
          icon={Timer}
          delta={deltaFor(data.avgMinutes, tShared("vsPreviousPeriod"), true)}
        />
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="mb-4 text-sm font-medium text-foreground">{t("chartTitle")}</p>
        <BarChart
          data={data.series.map((s) => ({ day: s.day, avgMinutes: s.avgMinutes ?? 0 }))}
          index="day"
          categories={["avgMinutes"]}
          colors={["violet"]}
          valueFormatter={(v) => formatMinutes(v)}
          className="h-72"
        />
      </div>
    </div>
  );
}

export function MessagesReportPanel({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.messages");
  const tShared = useTranslations("Reports");
  const { data, loading, error } = useReportData(loadMessagesReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <MetricCard
          title={t("incoming")}
          value={String(data.incoming.current)}
          icon={MessageCircle}
          delta={deltaFor(data.incoming, tShared("vsPreviousPeriod"))}
        />
        <MetricCard
          title={t("outgoing")}
          value={String(data.outgoing.current)}
          icon={Send}
          delta={deltaFor(data.outgoing, tShared("vsPreviousPeriod"))}
        />
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="mb-4 text-sm font-medium text-foreground">{t("chartTitle")}</p>
        <BarChart
          data={data.series}
          index="day"
          categories={["incoming", "outgoing"]}
          colors={["blue", "emerald"]}
          className="h-72"
        />
      </div>
    </div>
  );
}

export function ContactsReportPanel({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.contacts");
  const tShared = useTranslations("Reports");
  const { data, loading, error } = useReportData(loadContactsReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <MetricCard
          title={t("newContacts")}
          value={String(data.newContacts.current)}
          icon={UserPlus}
          delta={deltaFor(data.newContacts, tShared("vsPreviousPeriod"))}
        />
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="mb-4 text-sm font-medium text-foreground">{t("chartTitle")}</p>
        <BarChart
          data={data.series}
          index="day"
          categories={["value"]}
          colors={["blue"]}
          className="h-72"
        />
      </div>
    </div>
  );
}

export function AssignmentsReportPanel({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.assignments");
  const { data, loading, error } = useReportData(loadAssignmentsReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-1">
        <MetricCard title={t("totalConversations")} value={String(data.totalConversations)} icon={MessageCircle} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="mb-4 text-sm font-medium text-foreground">{t("byAgent")}</p>
          {data.byAgent.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noData")}</p>
          ) : (
            <BarChart
              data={data.byAgent}
              index="name"
              categories={["count"]}
              colors={["blue"]}
              layout="vertical"
              className="h-72"
            />
          )}
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="mb-4 text-sm font-medium text-foreground">{t("byTeam")}</p>
          {data.byTeam.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noData")}</p>
          ) : (
            <BarChart
              data={data.byTeam}
              index="name"
              categories={["count"]}
              colors={["violet"]}
              layout="vertical"
              className="h-72"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StatsTable({
  rows,
  t,
  rankColumn,
}: {
  rows: {
    userId: string;
    fullName: string;
    messagesSent: number;
    conversationsAssigned: number;
    conversationsClosed: number;
    avgResponseMinutes: number | null;
    rank?: number;
  }[];
  t: ReturnType<typeof useTranslations>;
  rankColumn: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            {rankColumn && <th className="px-4 py-3">{t("rank")}</th>}
            <th className="px-4 py-3">{t("agent")}</th>
            <th className="px-4 py-3 text-right">{t("messagesSent")}</th>
            <th className="px-4 py-3 text-right">{t("conversationsAssigned")}</th>
            <th className="px-4 py-3 text-right">{t("conversationsClosed")}</th>
            <th className="px-4 py-3 text-right">{t("avgResponse")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={rankColumn ? 6 : 5} className="px-4 py-8 text-center text-muted-foreground">
                {t("noData")}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.userId} className="border-b border-border last:border-0">
                {rankColumn && (
                  <td className="px-4 py-3 font-medium text-foreground">#{r.rank}</td>
                )}
                <td className="px-4 py-3 text-foreground">{r.fullName}</td>
                <td className="px-4 py-3 text-right text-foreground">{r.messagesSent}</td>
                <td className="px-4 py-3 text-right text-foreground">{r.conversationsAssigned}</td>
                <td className="px-4 py-3 text-right text-foreground">{r.conversationsClosed}</td>
                <td className="px-4 py-3 text-right text-foreground">
                  {r.avgResponseMinutes === null ? "—" : formatMinutes(r.avgResponseMinutes)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function LeaderboardReportPanel({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.leaderboard");
  const { data, loading, error } = useReportData(loadLeaderboardReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-1">
        <MetricCard title={t("topAgent")} value={data.entries[0]?.fullName ?? "—"} icon={Trophy} />
      </div>
      <StatsTable rows={data.entries} t={t} rankColumn />
    </div>
  );
}

export function UsersReportPanel({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.users");
  const { data, loading, error } = useReportData(loadUsersReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {t("scopeNotice")}
      </p>
      <div className="grid gap-4 sm:grid-cols-1">
        <MetricCard title={t("teamSize")} value={String(data.users.length)} icon={Users2} />
      </div>
      <StatsTable rows={data.users} t={t} rankColumn={false} />
    </div>
  );
}

export function LifecycleReportPanel({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.lifecycle");
  const { data, loading, error } = useReportData(loadLifecycleReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  const distributionSeries = LIFECYCLE_STAGES.map((stage) => ({
    stage: t(`stage.${stage}`),
    count: data.distribution[stage],
  }));
  const movedSeries = LIFECYCLE_STAGES.map((stage) => ({
    stage: t(`stage.${stage}`),
    count: data.movedIn[stage],
  }));

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {t("approximateNotice")}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="mb-4 text-sm font-medium text-foreground">{t("distributionTitle")}</p>
          <BarChart
            data={distributionSeries}
            index="stage"
            categories={["count"]}
            colors={["blue"]}
            className="h-72"
          />
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="mb-4 text-sm font-medium text-foreground">{t("movedTitle")}</p>
          <BarChart
            data={movedSeries}
            index="stage"
            categories={["count"]}
            colors={["violet"]}
            className="h-72"
          />
        </div>
      </div>
    </div>
  );
}

export function BroadcastsReportPanel({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.broadcasts");
  const tShared = useTranslations("Reports");
  const { data, loading, error } = useReportData(loadBroadcastsReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  const rate = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <MetricCard
          title={t("broadcastsSent")}
          value={String(data.broadcastsSent.current)}
          icon={Radio}
          delta={deltaFor(data.broadcastsSent, tShared("vsPreviousPeriod"))}
        />
        <MetricCard
          title={t("totalRecipients")}
          value={String(data.totalRecipients.current)}
          icon={TrendingUp}
          delta={deltaFor(data.totalRecipients, tShared("vsPreviousPeriod"))}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard title={t("deliveredRate")} value={rate(data.deliveredRate)} icon={CheckCircle2} />
        <MetricCard title={t("readRate")} value={rate(data.readRate)} icon={MessageCircle} />
        <MetricCard title={t("failedRate")} value={rate(data.failedRate)} icon={Clock} />
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="mb-4 text-sm font-medium text-foreground">{t("chartTitle")}</p>
        <BarChart
          data={data.series}
          index="day"
          categories={["sent"]}
          colors={["blue"]}
          className="h-72"
        />
      </div>
    </div>
  );
}

function minutesOrDash(minutes: number | null): string {
  return minutes === null ? "—" : formatMinutes(minutes);
}

/** Opened / resolved / avg-resolution table for one ticket dimension
 *  (category, priority, or team). */
function TicketBreakdownTable({
  title,
  rows,
  labelFor,
  t,
}: {
  title: string;
  rows: TicketBreakdownRow[];
  labelFor: (row: TicketBreakdownRow) => string;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <p className="px-4 pt-4 text-sm font-medium text-foreground">{title}</p>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2">{t("dimension")}</th>
            <th className="px-4 py-2 text-right">{t("colOpened")}</th>
            <th className="px-4 py-2 text-right">{t("colResolved")}</th>
            <th className="px-4 py-2 text-right">{t("avgResolution")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                {t("noBreakdownData")}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5 font-medium text-foreground">{labelFor(r)}</td>
                <td className="px-4 py-2.5 text-right text-foreground">{r.opened}</td>
                <td className="px-4 py-2.5 text-right text-foreground">{r.resolved}</td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">
                  {minutesOrDash(r.avgResolutionMinutes)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** "Resolved by resolution" (migration 096): tickets resolved or closed in the period, by how. */
export function ResolutionBreakdownTable({
  rows,
  t,
}: {
  rows: TicketResolutionRow[];
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card" data-testid="tickets-by-resolution">
      <p className="px-4 pt-4 text-sm font-medium text-foreground">{t("byResolution")}</p>
      <p className="px-4 pt-0.5 text-xs text-muted-foreground">{t("byResolutionHint")}</p>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2">{t("colResolution")}</th>
            <th className="px-4 py-2 text-right">{t("colResolved")}</th>
            <th className="px-4 py-2 text-right">{t("colShare")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                {t("noBreakdownData")}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5 font-medium text-foreground">
                  {r.key === "" ? t("noResolution") : (r.label ?? t("unknownResolution"))}
                </td>
                <td className="px-4 py-2.5 text-right text-foreground">{r.resolved}</td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">{Math.round(r.sharePct)}%</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function TicketsReportPanel({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.tickets");
  const tShared = useTranslations("Reports");
  const tCat = useTranslations("Tickets.detail.category");
  const tPri = useTranslations("Tickets.detail.priority");
  const { data, loading, error } = useReportData(loadTicketsReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  const vs = tShared("vsPreviousPeriod");
  const agingSeries = [
    { bucket: t("aging.under1d"), tickets: data.aging.under1d },
    { bucket: t("aging.d1to3"), tickets: data.aging.d1to3 },
    { bucket: t("aging.d3to7"), tickets: data.aging.d3to7 },
    { bucket: t("aging.over7d"), tickets: data.aging.over7d },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          title={t("opened")}
          value={String(data.opened.current)}
          icon={TicketIcon}
          delta={deltaFor(data.opened, vs)}
        />
        <MetricCard
          title={t("resolved")}
          value={String(data.resolved.current)}
          icon={CheckCircle2}
          delta={deltaFor(data.resolved, vs)}
        />
        <MetricCard
          title={t("avgResolution")}
          value={formatMinutes(data.avgResolutionMinutes.current)}
          icon={Timer}
          delta={deltaFor(data.avgResolutionMinutes, vs, true)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard title={t("openNow")} value={String(data.openNow)} icon={Clock} />
        <MetricCard
          title={t("avgFirstResponse")}
          value={formatMinutes(data.avgFirstResponseMinutes.current)}
          icon={MessageCircle}
          delta={deltaFor(data.avgFirstResponseMinutes, vs, true)}
        />
        <MetricCard
          title={t("resolvedWithin24h")}
          value={data.resolvedWithin24hPct === null ? "—" : `${Math.round(data.resolvedWithin24hPct)}%`}
          icon={TrendingUp}
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <p className="mb-4 text-sm font-medium text-foreground">{t("chartTitle")}</p>
        <BarChart
          data={data.series}
          index="day"
          categories={["opened", "resolved"]}
          colors={["blue", "emerald"]}
          className="h-72"
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <p className="text-sm font-medium text-foreground">{t("agingTitle")}</p>
        <p className="mb-4 mt-0.5 text-xs text-muted-foreground">{t("agingHint")}</p>
        <BarChart
          data={agingSeries}
          index="bucket"
          categories={["tickets"]}
          colors={["amber"]}
          className="h-56"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <TicketBreakdownTable
          title={t("byCategory")}
          rows={data.byCategory}
          labelFor={(r) => tCat(r.key as never)}
          t={t}
        />
        <TicketBreakdownTable
          title={t("byPriority")}
          rows={data.byPriority}
          labelFor={(r) => tPri(r.key as never)}
          t={t}
        />
      </div>
      <TicketBreakdownTable
        title={t("byTeam")}
        rows={data.byTeam}
        labelFor={(r) => r.label ?? (r.key === "" ? t("noTeam") : t("unknownTeam"))}
        t={t}
      />
      <ResolutionBreakdownTable rows={data.byResolution} t={t} />

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <p className="px-4 pt-4 text-sm font-medium text-foreground">{t("byAgent")}</p>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2">{t("agent")}</th>
              <th className="px-4 py-2 text-right">{t("ticketsResolved")}</th>
              <th className="px-4 py-2 text-right">{t("avgResolution")}</th>
              <th className="px-4 py-2 text-right">{t("agentOpenNow")}</th>
            </tr>
          </thead>
          <tbody>
            {data.byAgent.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                  {t("noData")}
                </td>
              </tr>
            ) : (
              data.byAgent.map((a) => (
                <tr key={a.userId} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium text-foreground">{a.fullName}</td>
                  <td className="px-4 py-3 text-right text-foreground">{a.ticketsResolved}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {minutesOrDash(a.avgResolutionMinutes)}
                  </td>
                  <td className="px-4 py-3 text-right text-foreground">{a.openNow}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <TicketSlaReportSection accountId={accountId} range={range} />
    </div>
  );
}

const pctText = (pct: number | null): string => (pct === null ? "—" : `${Math.round(pct)}%`);

/** "8 met · 2 breached · 3 running": the counts behind one compliance figure. */
function slaSubtitle(t: ReturnType<typeof useTranslations>, c: SlaCounts): string {
  return t("sla.counts", { met: c.met, breached: c.breached, running: c.running });
}

/** Met % for one breakdown row, both targets side by side. */
function SlaBreakdownTable({
  title,
  rows,
  labelFor,
  t,
}: {
  title: string;
  rows: SlaBreakdownRow[];
  labelFor: (row: SlaBreakdownRow) => string;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <p className="px-4 pt-4 text-sm font-medium text-foreground">{title}</p>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2">{t("dimension")}</th>
            <th className="px-4 py-2 text-right">{t("sla.firstResponseMet")}</th>
            <th className="px-4 py-2 text-right">{t("sla.resolutionMet")}</th>
            <th className="px-4 py-2 text-right">{t("sla.breachedCount")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                {t("noBreakdownData")}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5 font-medium text-foreground">{labelFor(r)}</td>
                <td className="px-4 py-2.5 text-right text-foreground" title={slaSubtitle(t, r.firstResponse)}>
                  {pctText(slaCompliancePct(r.firstResponse))}
                </td>
                <td className="px-4 py-2.5 text-right text-foreground" title={slaSubtitle(t, r.resolution)}>
                  {pctText(slaCompliancePct(r.resolution))}
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">
                  {r.firstResponse.breached + r.resolution.breached}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * SLA compliance (migration 086): first-response and resolution met %, by
 * priority and by team, and the tickets that missed a target, worst first, each
 * linking to the ticket. Aggregated by the database (`ticket_sla_report`).
 * Tickets with no policy are not part of it.
 */
function TicketSlaReportSection({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.tickets");
  const tPri = useTranslations("Tickets.detail.priority");
  const { nameOf } = useAccountMembers();
  const { data, loading, error } = useReportData(loadTicketSlaReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  const anyData =
    data.firstResponse.met +
      data.firstResponse.breached +
      data.firstResponse.running +
      data.resolution.met +
      data.resolution.breached +
      data.resolution.running >
    0;

  return (
    <div className="space-y-4" data-testid="ticket-sla-report">
      <div>
        <h3 className="text-base font-semibold text-foreground">{t("sla.title")}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("sla.hint")}</p>
      </div>
      {!anyData ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
          {t("sla.none")}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <MetricCard
              title={t("sla.firstResponseMet")}
              value={pctText(slaCompliancePct(data.firstResponse))}
              icon={ShieldCheck}
              subtitle={slaSubtitle(t, data.firstResponse)}
            />
            <MetricCard
              title={t("sla.resolutionMet")}
              value={pctText(slaCompliancePct(data.resolution))}
              icon={ShieldCheck}
              subtitle={slaSubtitle(t, data.resolution)}
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <SlaBreakdownTable
              title={t("sla.byPriority")}
              rows={data.byPriority}
              labelFor={(r) => tPri(r.key as never)}
              t={t}
            />
            <SlaBreakdownTable
              title={t("sla.byTeam")}
              rows={data.byTeam}
              labelFor={(r) => r.label ?? (r.key === "" ? t("noTeam") : t("unknownTeam"))}
              t={t}
            />
          </div>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <p className="px-4 pt-4 text-sm font-medium text-foreground">{t("sla.breachedTitle")}</p>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">{t("sla.colTicket")}</th>
                  <th className="px-4 py-2">{t("sla.colSubject")}</th>
                  <th className="px-4 py-2">{t("sla.colAssignee")}</th>
                  <th className="px-4 py-2">{t("sla.colTarget")}</th>
                  <th className="px-4 py-2 text-right">{t("sla.colOverdue")}</th>
                </tr>
              </thead>
              <tbody>
                {data.breached.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                      {t("sla.noBreaches")}
                    </td>
                  </tr>
                ) : (
                  data.breached.map((b) => (
                    <tr key={`${b.ticketId}-${b.target}`} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 font-mono text-xs">
                        <Link href={`/tickets?t=${b.ticketId}`} className="text-primary hover:underline">
                          #{b.ticketNumber}
                        </Link>
                      </td>
                      <td className="max-w-64 truncate px-4 py-2.5 text-foreground">{b.subject}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {b.assigneeId ? nameOf(b.assigneeId) : t("sla.unassigned")}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{t(`sla.target.${b.target}`)}</td>
                      <td className="px-4 py-2.5 text-right text-red-600 dark:text-red-400">
                        {formatDuration(b.overdueSeconds)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
