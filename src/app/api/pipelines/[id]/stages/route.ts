// GET   — list stages for a pipeline (accessible to anyone with pipelines access)
// POST  — create a new stage in this pipeline (pipelines.configure)
// PUT   — upsert the full stage list (pipelines.configure)
import { NextResponse } from "next/server";
import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { data: pipeline } = await ctx.supabase.from("pipelines").select("id").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!pipeline) return NextResponse.json({ error: "not found" }, { status: 404 });
    const { data, error } = await ctx.supabase.from("pipeline_stages").select("*").eq("pipeline_id", id).order("position");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ stages: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("pipelines.configure");
    const { id } = await params;
    const { data: pipeline } = await ctx.supabase.from("pipelines").select("id").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!pipeline) return NextResponse.json({ error: "not found" }, { status: 404 });
    const body = (await request.json().catch(() => null)) as { name?: string; color?: string; position?: number } | null;
    if (!body?.name) return NextResponse.json({ error: "name required" }, { status: 400 });
    const { data, error } = await ctx.supabase
      .from("pipeline_stages")
      .insert({ pipeline_id: id, name: body.name, color: body.color, position: body.position ?? 0 })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ stage: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("pipelines.configure");
    const { id } = await params;
    const { data: pipeline } = await ctx.supabase.from("pipelines").select("id").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!pipeline) return NextResponse.json({ error: "not found" }, { status: 404 });
    const body = (await request.json().catch(() => null)) as { stages?: unknown[] } | null;
    if (!Array.isArray(body?.stages)) return NextResponse.json({ error: "stages array required" }, { status: 400 });
    const { error } = await ctx.supabase.from("pipeline_stages").upsert(body.stages as object[], { onConflict: "id" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
