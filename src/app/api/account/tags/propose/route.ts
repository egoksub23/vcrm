import { NextResponse } from "next/server";
import { requireCapability, toErrorResponse } from "@/lib/auth/account";

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("tags.propose");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });

    const { action, ...rest } = body as { action: "propose_tag" | "propose_tag_edit" } & Record<string, unknown>;

    if (action === "propose_tag") {
      const { data, error } = await ctx.supabase.rpc("propose_tag", {
        p_kind: rest.p_kind,
        p_name: rest.p_name,
        p_color: rest.p_color,
        p_description: rest.p_description ?? null,
        p_also_other: rest.p_also_other ?? false,
      });
      if (error) return NextResponse.json({ error: error.message, code: (error as { code?: string }).code }, { status: 400 });
      return NextResponse.json(data);
    }

    if (action === "propose_tag_edit") {
      const { data, error } = await ctx.supabase.rpc("propose_tag_edit", {
        p_id: rest.p_id,
        p_patch: rest.p_patch,
      });
      if (error) return NextResponse.json({ error: error.message, code: (error as { code?: string }).code }, { status: 400 });
      return NextResponse.json(data);
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
