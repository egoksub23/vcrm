import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { loadMetrics, loadConversationsSeries, loadPipelineDonut, loadResponseTime, loadActivity } from "@/lib/dashboard/queries";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const query = searchParams.get("query") ?? "metrics";
    const db = ctx.supabase as unknown as SupabaseClient;

    switch (query) {
      case "metrics": {
        const metrics = await loadMetrics(db);
        return NextResponse.json({ metrics });
      }
      case "series": {
        const days = Math.min(Math.max(parseInt(searchParams.get("days") ?? "30", 10), 1), 365);
        const series = await loadConversationsSeries(db, days);
        return NextResponse.json({ series });
      }
      case "pipeline": {
        const pipeline = await loadPipelineDonut(db);
        return NextResponse.json({ pipeline });
      }
      case "response_time": {
        const responseTime = await loadResponseTime(db);
        return NextResponse.json({ responseTime });
      }
      case "activity": {
        const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 100);
        const activity = await loadActivity(db, limit);
        return NextResponse.json({ activity });
      }
      default:
        return NextResponse.json({ error: "unknown query" }, { status: 400 });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
