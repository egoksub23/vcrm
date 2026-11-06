import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

const SELECT = "*, contact:contacts(id, name, phone, wa_username, wa_user_id), comments:ticket_comments(count)";
const SEARCH_LIMIT = 500;

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

    const { data: matches, error: rpcErr } = await ctx.supabase.rpc("tickets_search", {
      p_account: ctx.accountId,
      p_search_text: body.p_search_text ?? "",
      p_search_number: body.p_search_number ?? null,
      p_search_prefix: body.p_search_prefix ?? null,
      p_quick: body.p_quick ?? [],
      p_user_id: body.p_user_id ?? ctx.userId,
      p_today: body.p_today ?? null,
      p_today_start: body.p_today_start ?? null,
      p_today_end: body.p_today_end ?? null,
      p_statuses: body.p_statuses ?? null,
      p_assignees: body.p_assignees ?? null,
      p_types: body.p_types ?? null,
      p_priorities: body.p_priorities ?? null,
      p_labels: body.p_labels ?? null,
      p_teams: body.p_teams ?? null,
      p_resolutions: body.p_resolutions ?? null,
      p_sort_key: body.p_sort_key ?? "updated_at",
      p_sort_dir: body.p_sort_dir ?? "desc",
      p_limit: body.p_limit ?? SEARCH_LIMIT,
      p_offset: body.p_offset ?? 0,
    });

    if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 });

    const rpcMatches = (matches ?? []) as { id: string; total_count: number }[];
    const ids = rpcMatches.map((m) => m.id);
    const total = rpcMatches[0]?.total_count ?? 0;

    if (ids.length === 0) return NextResponse.json({ tickets: [], total: 0 });

    const { data: hydrated, error: hydrateErr } = await ctx.supabase
      .from("tickets")
      .select(SELECT)
      .eq("account_id", ctx.accountId)
      .in("id", ids);
    if (hydrateErr) return NextResponse.json({ error: hydrateErr.message }, { status: 500 });

    const order = new Map(ids.map((id, i) => [id, i]));
    const ordered = ((hydrated ?? []) as { id: string }[]).sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );

    return NextResponse.json({ tickets: ordered, total });
  } catch (err) {
    return toErrorResponse(err);
  }
}
