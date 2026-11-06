import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { normalizeSettings } from "@/lib/jira/settings";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;

    const [linkRes, connRes] = await Promise.all([
      ctx.supabase
        .from("ticket_jira_links")
        .select("*")
        .eq("ticket_id", id)
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: true }),
      ctx.supabase
        .from("jira_connections")
        .select("id, status, status_reason, site_name, site_url, settings")
        .eq("account_id", ctx.accountId)
        .limit(1),
    ]);

    const links = linkRes.data ?? [];
    const rawConn = ((connRes.data as { id: string; status: string; status_reason: string | null; site_name: string | null; site_url: string; settings: unknown }[] | null) ?? [])[0];
    const connection = rawConn
      ? { id: rawConn.id, status: rawConn.status, statusReason: rawConn.status_reason, siteName: rawConn.site_name, siteUrl: rawConn.site_url, settings: normalizeSettings(rawConn.settings) }
      : null;

    let sharedNoteIds: string[] = [];
    let attachmentMaps: { id: string; ticket_attachment_id: string | null; direction: string; status: string; filename: string | null; jira_url: string | null }[] = [];

    if (links.length > 0) {
      const linkIds = (links as { id: string }[]).map((r) => r.id);
      const [attRes, mapRes] = await Promise.all([
        ctx.supabase
          .from("jira_attachment_map")
          .select("id, ticket_attachment_id, direction, status, filename, jira_url")
          .in("link_id", linkIds),
        ctx.supabase
          .from("jira_comment_map")
          .select("ticket_comment_id")
          .in("link_id", linkIds)
          .eq("origin", "vircle")
          .not("ticket_comment_id", "is", null),
      ]);
      attachmentMaps = (attRes.data as typeof attachmentMaps | null) ?? [];
      sharedNoteIds = ((mapRes.data as { ticket_comment_id: string }[] | null) ?? []).map((r) => r.ticket_comment_id);
    }

    return NextResponse.json({ links, connection, sharedNoteIds, attachmentMaps });
  } catch (err) {
    return toErrorResponse(err);
  }
}
