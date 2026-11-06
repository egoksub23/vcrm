// GET — list all custom field values for a contact
// PUT — replace all custom field values for a contact (delete + insert)
import { NextResponse } from "next/server";
import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id: contactId } = await params;
    const { data, error } = await ctx.supabase
      .from("contact_custom_values")
      .select("custom_field_id, value")
      .eq("contact_id", contactId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ values: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("contacts.edit");
    const { id: contactId } = await params;
    const body = (await request.json().catch(() => null)) as { values?: { custom_field_id: string; value: string }[] } | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });

    await ctx.supabase.from("contact_custom_values").delete().eq("contact_id", contactId);

    const rows = (body.values ?? []).filter((v) => v.custom_field_id && v.value.trim()).map((v) => ({
      contact_id: contactId,
      custom_field_id: v.custom_field_id,
      value: v.value.trim(),
    }));

    if (rows.length > 0) {
      const { error } = await ctx.supabase.from("contact_custom_values").insert(rows);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
