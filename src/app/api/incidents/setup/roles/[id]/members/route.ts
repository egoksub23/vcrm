// /api/incidents/setup/roles/[id]/members — who holds a role.
//   POST   { contact_id, is_backup? }            add a person (goes to the end of the order)
//   PATCH  { member_id, position?, is_backup?, away_from?, away_to? }
//   DELETE ?member_id=...                         take a person out of the role
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { parseMemberPatch } from "@/lib/incidents/platform/input";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id: roleId } = await params;
    const body = (await request.json().catch(() => null)) as { contact_id?: unknown; is_backup?: unknown } | null;
    if (typeof body?.contact_id !== "string") return NextResponse.json({ error: "Choose a person to add." }, { status: 400 });

    const { data: role } = await ctx.supabase.from("incident_roles").select("id, kind").eq("id", roleId).eq("account_id", ctx.accountId).maybeSingle();
    if (!role) return NextResponse.json({ error: "Role not found." }, { status: 404 });
    if ((role as { kind: string }).kind !== "fixed") {
      return NextResponse.json({ error: "This role is worked out for each incident, so it has no fixed people." }, { status: 400 });
    }
    const { data: existing } = await ctx.supabase.from("incident_role_members").select("position").eq("role_id", roleId).order("position", { ascending: false }).limit(1);
    const next = (((existing ?? []) as { position: number }[])[0]?.position ?? 0) + 1;

    const { data, error } = await ctx.supabase
      .from("incident_role_members")
      .insert({ account_id: ctx.accountId, role_id: roleId, contact_id: body.contact_id, position: next, is_backup: body.is_backup === true })
      .select("*")
      .single();
    if (error || !data) {
      if (error?.code === "23505") return NextResponse.json({ error: "That person is already in this role." }, { status: 409 });
      if (error?.message?.includes("same account")) return NextResponse.json({ error: "That person is not in your school's list." }, { status: 400 });
      console.error("[POST members]", error);
      return NextResponse.json({ error: "Could not add the person." }, { status: 500 });
    }
    return NextResponse.json({ member: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id: roleId } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const memberId = typeof body?.member_id === "string" ? body.member_id : null;
    if (!memberId) return NextResponse.json({ error: "member_id is required." }, { status: 400 });
    const parsed = parseMemberPatch(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    if (Object.keys(parsed.value).length === 0) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("incident_role_members")
      .update({ ...parsed.value })
      .eq("id", memberId)
      .eq("role_id", roleId)
      .eq("account_id", ctx.accountId)
      .select("*")
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Could not save the changes." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Person not found in this role." }, { status: 404 });
    return NextResponse.json({ member: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const { id: roleId } = await params;
    const memberId = new URL(request.url).searchParams.get("member_id");
    if (!memberId) return NextResponse.json({ error: "member_id is required." }, { status: 400 });
    const { error } = await ctx.supabase.from("incident_role_members").delete().eq("id", memberId).eq("role_id", roleId).eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: "Could not remove the person." }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
