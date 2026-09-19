"use client";

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { useAuth } from "@/hooks/use-auth";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DateRangePicker, presetToRange, type ReportPreset } from "@/components/reports/date-range-picker";
import {
  ConversationsReportPanel,
  ResponsesReportPanel,
  ResolutionsReportPanel,
  MessagesReportPanel,
  ContactsReportPanel,
  AssignmentsReportPanel,
  LeaderboardReportPanel,
  UsersReportPanel,
  LifecycleReportPanel,
  BroadcastsReportPanel,
  TicketsReportPanel,
} from "@/components/reports/report-panels";

const REPORT_TABS = [
  "conversations",
  "responses",
  "resolutions",
  "messages",
  "contacts",
  "assignments",
  "leaderboard",
  "users",
  "lifecycle",
  "broadcasts",
  "tickets",
] as const;
type ReportTab = (typeof REPORT_TABS)[number];

function isReportTab(value: string | null): value is ReportTab {
  return !!value && (REPORT_TABS as readonly string[]).includes(value);
}

// Same reason as Settings: `useSearchParams` opts the page out of
// static prerendering unless it sits under a Suspense boundary.
export default function ReportsPage() {
  return (
    <Suspense fallback={null}>
      <ReportsPageInner />
    </Suspense>
  );
}

function ReportsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { accountId } = useAuth();
  const t = useTranslations("Reports");

  const tab: ReportTab = isReportTab(searchParams.get("tab")) ? (searchParams.get("tab") as ReportTab) : "conversations";
  const [preset, setPreset] = useState<ReportPreset>("7d");
  const range = useMemo(() => presetToRange(preset), [preset]);

  const go = (next: ReportTab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`/reports?${params.toString()}`, { scroll: false });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("pageTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("pageDesc")}</p>
        </div>
        <DateRangePicker preset={preset} onChange={setPreset} />
      </div>

      <Tabs value={tab} onValueChange={(v) => go(v as ReportTab)} className="mt-6">
        <TabsList className="flex-wrap">
          <TabsTrigger value="conversations">{t("tabs.conversations")}</TabsTrigger>
          <TabsTrigger value="responses">{t("tabs.responses")}</TabsTrigger>
          <TabsTrigger value="resolutions">{t("tabs.resolutions")}</TabsTrigger>
          <TabsTrigger value="messages">{t("tabs.messages")}</TabsTrigger>
          <TabsTrigger value="contacts">{t("tabs.contacts")}</TabsTrigger>
          <TabsTrigger value="assignments">{t("tabs.assignments")}</TabsTrigger>
          <TabsTrigger value="leaderboard">{t("tabs.leaderboard")}</TabsTrigger>
          <TabsTrigger value="users">{t("tabs.users")}</TabsTrigger>
          <TabsTrigger value="lifecycle">{t("tabs.lifecycle")}</TabsTrigger>
          <TabsTrigger value="broadcasts">{t("tabs.broadcasts")}</TabsTrigger>
          <TabsTrigger value="tickets">{t("tabs.tickets")}</TabsTrigger>
        </TabsList>

        <TabsContent value="conversations" className="mt-4">
          <ConversationsReportPanel accountId={accountId} range={range} />
        </TabsContent>
        <TabsContent value="responses" className="mt-4">
          <ResponsesReportPanel accountId={accountId} range={range} />
        </TabsContent>
        <TabsContent value="resolutions" className="mt-4">
          <ResolutionsReportPanel accountId={accountId} range={range} />
        </TabsContent>
        <TabsContent value="messages" className="mt-4">
          <MessagesReportPanel accountId={accountId} range={range} />
        </TabsContent>
        <TabsContent value="contacts" className="mt-4">
          <ContactsReportPanel accountId={accountId} range={range} />
        </TabsContent>
        <TabsContent value="assignments" className="mt-4">
          <AssignmentsReportPanel accountId={accountId} range={range} />
        </TabsContent>
        <TabsContent value="leaderboard" className="mt-4">
          <LeaderboardReportPanel accountId={accountId} range={range} />
        </TabsContent>
        <TabsContent value="users" className="mt-4">
          <UsersReportPanel accountId={accountId} range={range} />
        </TabsContent>
        <TabsContent value="lifecycle" className="mt-4">
          <LifecycleReportPanel accountId={accountId} range={range} />
        </TabsContent>
        <TabsContent value="broadcasts" className="mt-4">
          <BroadcastsReportPanel accountId={accountId} range={range} />
        </TabsContent>
        <TabsContent value="tickets" className="mt-4">
          <TicketsReportPanel accountId={accountId} range={range} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
