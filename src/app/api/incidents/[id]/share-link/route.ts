// POST /api/incidents/[id]/share-link — generate a 7-day read-only signed share link for one incident.
// Requires incidents.manage. The link works without a login; it shows only public-safe fields (no names, no medical detail).
import { NextResponse } from "next/server";

import { requireAnyCapability, toErrorResponse } from "@/lib/auth/account";
import { createShareToken } from "@/lib/incidents/platform/share-links";
import { createAdminPgDb } from "@/lib/postgres/db";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await requireAnyCapability(["incidents.manage"]);
    const { id } = await params;

    const { data } = await createAdminPgDb()
      .from("incidents")
      .select("id")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!data) return NextResponse.json({ error: "Incident not found." }, { status: 404 });

    const token = createShareToken(id);
    if (!token) return NextResponse.json({ error: "Share links are not available (signing key not configured)." }, { status: 500 });

    const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
    return NextResponse.json({ url: `${base}/incident-share/${token}` });
  } catch (err) {
    return toErrorResponse(err);
  }
}
