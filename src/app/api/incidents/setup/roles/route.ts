// POST /api/incidents/setup/roles — add a role (a job that rules can tell), for example "Bursar".
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { parseRole, roleKeyFrom } from "@/lib/incidents/platform/input";

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const parsed = parseRole(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { name, description, notify_mode } = parsed.value;

    const { data, error } = await ctx.supabase
      .from("incident_roles")
      .insert({
        account_id: ctx.accountId,
        key: roleKeyFrom(name!),
        name: { en: name },
        description: description ?? null,
        notify_mode: notify_mode ?? "all",
        kind: "fixed",
        sort_order: 500,
      })
      .select("*")
      .single();
    if (error || !data) {
      if (error?.code === "23505") return NextResponse.json({ error: "There is already a role with that name." }, { status: 409 });
      console.error("[POST /api/incidents/setup/roles]", error);
      return NextResponse.json({ error: "Could not add the role." }, { status: 500 });
    }
    return NextResponse.json({ role: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
