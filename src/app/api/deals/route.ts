import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

const COLUMNS = "id, title, status, value, currency, contact_id";
const COLUMNS_WITH_STAGE = "*, stage:pipeline_stages(*)";
const COLUMNS_BOARD = "*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)";

function safeQuery(q: string) {
  return q.replace(/[,()%*\\"]/g, " ").replace(/\s+/g, " ").trim();
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const q = safeQuery(searchParams.get("q") ?? "");
    const contactId = searchParams.get("contactId") ?? null;
    const pipelineId = searchParams.get("pipelineId") ?? null;
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "8", 10), 50);
    const withStage = searchParams.get("with_stage") === "true";
    const board = searchParams.get("board") === "true";
    const all = searchParams.get("all") === "true";

    const cols = board ? COLUMNS_BOARD : withStage ? COLUMNS_WITH_STAGE : COLUMNS;
    let query = ctx.supabase.from("deals").select(cols).eq("account_id", ctx.accountId);
    if (contactId) query = query.eq("contact_id", contactId);
    if (pipelineId) query = query.eq("pipeline_id", pipelineId);
    if (q) {
      query = query.or(`title.ilike.%${q}%`);
    } else {
      query = query.order("created_at", { ascending: false });
    }
    if (!all) query = query.limit(limit);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ deals: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });
    const { data, error } = await ctx.supabase
      .from("deals")
      .insert({ ...body, account_id: ctx.accountId })
      .select(COLUMNS)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ deal: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
