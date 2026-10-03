// ============================================================
// GET /api/account/export  (owner)
//
// Everything the workspace owns as one zip: a CSV per table, the stored files,
// a manifest and a README (see lib/platform/workspace-export.ts). Secrets are
// never included. Streamed, so a large workspace does not have to fit in memory.
//   ?files=0   leave the stored files out (data only)
//
// The workspace's owner only: it is all of the workspace's customer data.
// ============================================================
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { exportFileName, workspaceExportStream } from "@/lib/platform/workspace-export";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const ctx = await requireRole("owner");
    // A full export is heavy: a few an hour is plenty.
    const limit = checkRateLimit(`workspace-export:${ctx.accountId}`, { limit: 5, windowMs: 3_600_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const withFiles = new URL(request.url).searchParams.get("files") !== "0";
    const db = supabaseAdmin();
    const { data: account } = await db.from("accounts").select("name").eq("id", ctx.accountId).maybeSingle();
    const name = (account?.name as string | undefined) ?? null;

    return new Response(workspaceExportStream(db, ctx.accountId, { files: withFiles, accountName: name ?? undefined }), {
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
