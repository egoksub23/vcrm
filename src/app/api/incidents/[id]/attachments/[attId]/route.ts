// DELETE /api/incidents/[id]/attachments/[attId] — removes a file from an incident, and the stored file with it. Allowed to whoever added it and to anyone who
// manages incidents (row-level security decides). The chain-of-custody log keeps its line (the file's name and checksum) after the file is gone.
import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { createAdminPgDb } from "@/lib/postgres/db";
import { appStorage } from "@/lib/storage/provider";

type Params = { params: Promise<{ id: string; attId: string }> };

const BUCKET = "chat-media";

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id, attId } = await params;

    const { data: row } = await ctx.supabase.from("incident_attachments").select("id, filename, storage_path").eq("id", attId).eq("incident_id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!row) return NextResponse.json({ error: "File not found." }, { status: 404 });

    const { error } = await ctx.supabase.from("incident_attachments").delete().eq("id", attId).eq("incident_id", id).eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Row-level security can refuse a delete without an error: check that it is really gone before saying so.
    const { data: still } = await ctx.supabase.from("incident_attachments").select("id").eq("id", attId).maybeSingle();
    if (still) return NextResponse.json({ error: "You can only delete files you added, unless you manage incidents." }, { status: 403 });

    const gone = row as { filename: string; storage_path: string };
    // Removing evidence is itself recorded (the custody log keeps the file's own line; this says who removed it and when).
    await createAdminPgDb().from("incident_activity").insert({ incident_id: id, account_id: ctx.accountId, actor_id: ctx.userId, event_type: "file_deleted", from_value: gone.filename.slice(0, 200) });
    void appStorage().from(BUCKET).remove([gone.storage_path]).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
