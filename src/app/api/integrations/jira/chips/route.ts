import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

const CHIP_BATCH = 100;

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as { ticketIds?: string[] } | null;
    const ticketIds = body?.ticketIds ?? [];
    if (ticketIds.length === 0) return NextResponse.json({ chips: {} });

    const batches: string[][] = [];
    for (let i = 0; i < ticketIds.length; i += CHIP_BATCH) batches.push(ticketIds.slice(i, i + CHIP_BATCH));

    const results = await Promise.all(
      batches.map((batch) =>
        ctx.supabase
          .from("ticket_jira_links")
          .select("ticket_id, issue_key, status_category, issue_url, sync_state, created_at")
          .eq("account_id", ctx.accountId)
          .in("ticket_id", batch)
          .order("created_at", { ascending: true }),
      ),
    );

    const chips: Record<string, { key: string; status_category: string | null; issue_url: string | null; sync_state: string; created_at: string }[]> = {};
    for (const res of results) {
      for (const r of (res.data as { ticket_id: string; issue_key: string; status_category: string | null; issue_url: string | null; sync_state: string; created_at: string }[] | null) ?? []) {
        (chips[r.ticket_id] ??= []).push({
          key: r.issue_key,
          status_category: r.status_category,
          issue_url: r.issue_url,
          sync_state: r.sync_state,
          created_at: r.created_at,
        });
      }
    }

    return NextResponse.json({ chips });
  } catch (err) {
    return toErrorResponse(err);
  }
}
