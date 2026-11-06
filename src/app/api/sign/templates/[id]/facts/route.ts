import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { mergeKeysOf } from "@/lib/sign/client/layout";
import { roleInfos } from "@/lib/sign/bulk/plan";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { SignRole } from "@/lib/sign/types";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;

    const { data: t, error: tErr } = await ctx.supabase
      .from("sign_templates")
      .select("current_version_id")
      .eq("id", id)
      .maybeSingle();
    if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
    const versionId = (t as { current_version_id: string | null } | null)?.current_version_id;
    if (!versionId) return NextResponse.json({ facts: null });

    const { data: v, error: vErr } = await ctx.supabase
      .from("sign_template_versions")
      .select("roles, fields")
      .eq("id", versionId)
      .maybeSingle();
    if (vErr || !v) return NextResponse.json({ facts: null });

    const row = v as { roles: SignRole[]; fields: PlacedField[] };
    const fields = Array.isArray(row.fields) ? row.fields : [];
    const roles = Array.isArray(row.roles) ? row.roles : [];
    return NextResponse.json({
      facts: { roles: roleInfos(roles, fields), mergeKeys: mergeKeysOf(fields).map((k) => k.key) },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
