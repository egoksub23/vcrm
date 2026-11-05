import { NextResponse } from "next/server";
import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";

const SPEC_DEFAULT_STAGES = [
  { name: "New Lead", color: "#3b82f6", position: 0 },
  { name: "Qualified", color: "#eab308", position: 1 },
  { name: "Proposal Sent", color: "#f97316", position: 2 },
  { name: "Negotiation", color: "#8b5cf6", position: 3 },
  { name: "Won", color: "#22c55e", position: 4 },
];

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const minimal = searchParams.get("minimal") === "true";
    const { data, error } = await ctx.supabase
      .from("pipelines")
      .select(minimal ? "id, name" : "*")
      .eq("account_id", ctx.accountId)
      .order("created_at");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ pipelines: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("pipelines.configure");
    const body = (await request.json().catch(() => null)) as { name?: string; seed_stages?: boolean } | null;
    const name = body?.name?.trim();
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

    const { data: pipeline, error } = await ctx.supabase
      .from("pipelines")
      .insert({ user_id: ctx.userId, account_id: ctx.accountId, name })
      .select()
      .single();

    if (error || !pipeline) return NextResponse.json({ error: error?.message ?? "Failed to create" }, { status: 500 });

    if (body?.seed_stages !== false) {
      await ctx.supabase.from("pipeline_stages").insert(
        SPEC_DEFAULT_STAGES.map((s) => ({ pipeline_id: (pipeline as { id: string }).id, ...s }))
      );
    }

    return NextResponse.json({ pipeline }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
