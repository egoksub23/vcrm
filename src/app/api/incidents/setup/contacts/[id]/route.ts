// PATCH /api/incidents/setup/contacts/[id] — change a person's details. DELETE removes them from every role.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { parseContact } from "@/lib/incidents/platform/input";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const parsed = parseContact(await request.json().catch(() => null), true);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    if (Object.keys(parsed.value).length === 0) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("incident_contacts")
      .update(parsed.value)
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("*")
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Could not save the changes." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Person not found." }, { status: 404 });
    return NextResponse.json({ contact: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id } = await params;
    const { error } = await ctx.supabase.from("incident_contacts").delete().eq("id", id).eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: "Could not remove the person." }, { status: 500 });
    // Past messages keep the name and address they were sent to (the log stores a snapshot).
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
