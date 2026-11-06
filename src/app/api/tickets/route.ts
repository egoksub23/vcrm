import { NextResponse } from "next/server";
import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";

const COLUMNS = "id, ticket_number, subject, status, contact_id";
const COLUMNS_FULL =
  "id, ticket_number, subject, status, priority, category, conversation_id, contact_id, created_at, updated_at, sla_policy_id, sla_first_response_due_at, sla_first_response_risk_at, sla_first_response_state, sla_resolution_due_at, sla_resolution_risk_at, sla_resolution_state";

function safeQuery(q: string) {
  return q.replace(/[,()%*\\"]/g, " ").replace(/\s+/g, " ").trim();
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const q = safeQuery(searchParams.get("q") ?? "");
    const contactId = searchParams.get("contactId") ?? null;
    const idsParam = searchParams.get("ids") ?? null;
    const full = searchParams.get("full") === "true";
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "8", 10), 100);

    const cols = full ? COLUMNS_FULL : COLUMNS;
    let query = ctx.supabase.from("tickets").select(cols).eq("account_id", ctx.accountId);

    if (idsParam) {
      const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
      query = query.in("id", ids);
      const { data, error } = await query;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ tickets: data ?? [] });
    }

    if (contactId) query = query.eq("contact_id", contactId);
    if (q) {
      const num = parseInt(q, 10);
      if (!isNaN(num)) {
        query = query.eq("ticket_number", num);
      } else {
        query = query.ilike("subject", `%${q}%`);
      }
    } else {
      query = query.order("created_at", { ascending: false });
    }
    const { data, error } = await query.limit(limit);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ tickets: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("tickets.work");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });

    const { data: ticketNumber, error: seqError } = await ctx.supabase.rpc("next_ticket_number", {
      p_account_id: ctx.accountId,
    });
    if (seqError || ticketNumber == null) {
      return NextResponse.json({ error: "failed to generate ticket number" }, { status: 500 });
    }

    const { data, error } = await ctx.supabase
      .from("tickets")
      .insert({
        account_id: ctx.accountId,
        ticket_number: ticketNumber,
        contact_id: body.contact_id ?? null,
        conversation_id: body.conversation_id ?? null,
        subject: body.subject,
        description: body.description ?? null,
        category: body.category ?? "general",
        priority: body.priority ?? "normal",
        assigned_agent_id: body.assigned_agent_id ?? null,
        assigned_team_id: body.assigned_team_id ?? null,
        labels: body.labels ?? [],
        due_date: body.due_date ?? null,
        custom_fields: body.custom_fields ?? {},
        created_by: ctx.userId,
      })
      .select("*")
      .single();

    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });
    }
    return NextResponse.json({ ticket: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
