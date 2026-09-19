"use client";

import { useTranslations } from "next-intl";
import { MessageCircle, CheckCircle2, Clock, Timer, Send, UserPlus, Users2, Trophy, Radio, TrendingUp, Ticket as TicketIcon } from "lucide-react";
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
  LIFECYCLE_STAGES,
  type OverviewMetric,
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

export function TicketsReportPanel({ accountId, range }: PanelProps) {
  const t = useTranslations("Reports.tickets");
  const tShared = useTranslations("Reports");
  const { data, loading, error } = useReportData(loadTicketsReport, accountId, range);

  if (error) return <ErrorState message={error} />;
  if (loading || !data) return <EmptyState label={t("loading")} />;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          title={t("opened")}
          value={String(data.opened.current)}
          icon={TicketIcon}
          delta={deltaFor(data.opened, tShared("vsPreviousPeriod"))}
        />
        <MetricCard
          title={t("resolved")}
          value={String(data.resolved.current)}
          icon={CheckCircle2}
          delta={deltaFor(data.resolved, tShared("vsPreviousPeriod"))}
        />
        <MetricCard
          title={t("avgResolution")}
          value={formatMinutes(data.avgResolutionMinutes.current)}
          icon={Timer}
          delta={deltaFor(data.avgResolutionMinutes, tShared("vsPreviousPeriod"), true)}
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
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t("agent")}</th>
              <th className="px-4 py-3 text-right">{t("ticketsResolved")}</th>
              <th className="px-4 py-3 text-right">{t("avgResolution")}</th>
            </tr>
          </thead>
          <tbody>
            {data.byAgent.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                  {t("noData")}
                </td>
              </tr>
            ) : (
              data.byAgent.map((a) => (
                <tr key={a.userId} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium text-foreground">{a.fullName}</td>
                  <td className="px-4 py-3 text-right text-foreground">{a.ticketsResolved}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {a.avgResolutionMinutes === null ? "—" : formatMinutes(a.avgResolutionMinutes)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
