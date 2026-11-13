// POST /api/incidents/setup/contacts — add a person who can be told about incidents (staff or outside).
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { parseContact } from "@/lib/incidents/platform/input";

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const parsed = parseContact(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("incident_contacts")
      .insert({ preferred_channels: ["email"], kind: "staff", ...parsed.value, account_id: ctx.accountId })
      .select("*")
      .single();
    if (error || !data) {
      if (error?.code === "23505") return NextResponse.json({ error: "That Halo user is already a contact." }, { status: 409 });
      console.error("[POST /api/incidents/setup/contacts]", error);
      return NextResponse.json({ error: "Could not add the person." }, { status: 500 });
    }
    return NextResponse.json({ contact: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
