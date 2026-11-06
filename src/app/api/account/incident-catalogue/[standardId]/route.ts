import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

const STANDARD_COLUMNS = "id, slug, name, regulatory_body, sector, description, is_system, kind, created_at";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ standardId: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { standardId } = await params;

    const [stdRes, typesRes, sevRes] = await Promise.all([
      ctx.supabase
        .from("incident_standards")
        .select(STANDARD_COLUMNS)
        .eq("id", standardId)
        .maybeSingle(),
      ctx.supabase
        .from("incident_type_catalogue")
        .select("*")
        .eq("standard_id", standardId)
        .order("position"),
      ctx.supabase
        .from("incident_severity_levels")
        .select("*")
        .eq("standard_id", standardId)
        .order("position"),
    ]);

    if (!stdRes.data) return NextResponse.json({ catalogue: null });

    return NextResponse.json({
      catalogue: {
        standard: stdRes.data,
        types: typesRes.data ?? [],
        severities: sevRes.data ?? [],
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
