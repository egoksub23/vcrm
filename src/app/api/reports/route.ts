import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  loadConversationsReport,
  loadResponsesReport,
  loadResolutionsReport,
  loadMessagesReport,
  loadAssignmentsReport,
  loadLeaderboardReport,
  loadUsersReport,
  loadLifecycleReport,
  loadBroadcastsReport,
  loadContactsReport,
  loadTicketsReport,
  loadTicketSlaReport,
  loadTicketReportsDrilldown,
} from "@/lib/reports/queries";
import type { DateRange } from "@/lib/reports/date-utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

const LOADERS: Record<string, (db: AnyDb, accountId: string, range: DateRange) => Promise<unknown>> = {
  conversations: loadConversationsReport,
  responses: loadResponsesReport,
  resolutions: loadResolutionsReport,
  messages: loadMessagesReport,
  assignments: loadAssignmentsReport,
  leaderboard: loadLeaderboardReport,
  users: loadUsersReport,
  lifecycle: loadLifecycleReport,
  broadcasts: loadBroadcastsReport,
  contacts: loadContactsReport,
  tickets: loadTicketsReport,
  ticket_sla: loadTicketSlaReport,
  ticket_drilldown: loadTicketReportsDrilldown,
};

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("query") ?? "";
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    const loader = LOADERS[query];
    if (!loader) return NextResponse.json({ error: "unknown query" }, { status: 400 });
    if (!from || !to) return NextResponse.json({ error: "from and to required" }, { status: 400 });

    const range: DateRange = { from: new Date(from), to: new Date(to) };
    const data = await loader(ctx.supabase as AnyDb, ctx.accountId, range);
    return NextResponse.json({ data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
