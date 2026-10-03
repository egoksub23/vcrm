// ============================================================
// GET /api/platform/accounts/[id]/export — the operator's copy of a workspace's
// data, for handing to the owner before it is deleted.
//
// Only while the workspace has a deletion pending (requested by its owner or by
// the operator at the customer's request): the operator never gets a standing way
// to read a customer's data. Same zip as the owner's export.
// ============================================================
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { exportFileName, workspaceExportStream } from "@/lib/platform/workspace-export";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePlatformAdmin();
    const limit = checkRateLimit(`platform:export:${ctx.userId}`, { limit: 5, windowMs: 3_600_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid workspace id" }, { status: 400 });

    const db = supabaseAdmin();
    const { data: platform } = await db.from("account_platform").select("deletion_due_at").eq("account_id", id).maybeSingle();
    if (!platform?.deletion_due_at) {
      return NextResponse.json(
        { error: "A workspace can be exported by the operator only once its deletion has been requested" },
        { status: 403 },
      );
    }
    const { data: account } = await db.from("accounts").select("name").eq("id", id).maybeSingle();
    if (!account) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    const name = account.name as string;
    const withFiles = new URL(request.url).searchParams.get("files") !== "0";

    return new Response(workspaceExportStream(db, id, { files: withFiles, accountName: name }), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${exportFileName(name)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
