import { NextResponse } from "next/server";
import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";
import { isNoteKind } from "@/lib/incidents/platform/note-kinds";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      body?: string;
      mentions?: string[];
      kind?: unknown;
    } | null;
    if (!body?.body?.trim()) return NextResponse.json({ error: "body required" }, { status: 400 });
    // A note can be written as an investigation note, a finding or a closing note (migration 230): that is for people who manage incidents.
    if (body.kind !== undefined && body.kind !== null) {
      if (!isNoteKind(body.kind)) return NextResponse.json({ error: "That kind of note is not known." }, { status: 400 });
      await requireCapability("incidents.manage");
    }

    const { data, error } = await ctx.supabase
      .from("incident_comments")
      .insert({
        incident_id: id,
        account_id: ctx.accountId,
        author_id: ctx.userId,
        body: body.body.trim(),
        mentions: body.mentions ?? [],
        ...(isNoteKind(body.kind) ? { kind: body.kind, is_finding: body.kind === "finding" } : {}),
      })
      .select("*")
      .single();

    if (error || !data) return NextResponse.json({ error: error?.message ?? "insert_failed" }, { status: 500 });
    return NextResponse.json({ comment: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
