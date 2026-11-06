import { NextResponse } from "next/server";
import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";
import { findExistingContact } from "@/lib/contacts/dedupe";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { data, error } = await ctx.supabase
      .from("contacts")
      .select("*")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ contact: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const ALLOWED_PATCH = ["name", "phone", "email", "company", "country", "language", "language_source", "lifecycle_stage", "lifecycle_stage_changed_at", "updated_at"] as const;

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("contacts.edit");
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });

    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED_PATCH) {
      if (key in body) patch[key] = body[key];
    }

    const { error } = await ctx.supabase
      .from("contacts")
      .update(patch)
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) {
      if ((error as { code?: string }).code === "23505") {
        const phone = typeof body.phone === "string" ? body.phone : null;
        const conflict = phone
          ? await findExistingContact(ctx.supabase as never, ctx.accountId, phone, id)
          : null;
        return NextResponse.json({ error: "duplicate_phone", conflict }, { status: 409 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // If phone changed, check for a merge candidate (a different contact with
    // the same trunk-normalized number — the user may want to fold it in).
    const phone = typeof body.phone === "string" ? body.phone : null;
    let mergeCandidate = null;
    if (phone) {
      mergeCandidate = await findExistingContact(ctx.supabase as never, ctx.accountId, phone, id);
    }

    return NextResponse.json({ ok: true, mergeCandidate });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("contacts.edit");
    const { id } = await params;
    const { error } = await ctx.supabase
      .from("contacts")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
