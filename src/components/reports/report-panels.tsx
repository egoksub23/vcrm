"use client";

import { useTranslations } from "next-intl";
import { MessageCircle, CheckCircle2, Clock, Timer, Send, UserPlus } from "lucide-react";
import { MetricCard } from "@/components/dashboard/metric-card";
import { BarChart } from "@/components/tremor/bar-chart";
import type { DateRange } from "@/lib/reports/date-utils";
import {
  loadConversationsReport,
  loadResponsesReport,
  loadResolutionsReport,
  loadMessagesReport,
  loadContactsReport,
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
