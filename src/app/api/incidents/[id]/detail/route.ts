import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const q = { eq: ["incident_id", id] as [string, string] };
    void q; // used below

    const [inc, com, act, att, ns, ac, ob] = await Promise.all([
      ctx.supabase.from("incidents").select("*").eq("id", id).eq("account_id", ctx.accountId).maybeSingle(),
      ctx.supabase.from("incident_comments").select("*").eq("incident_id", id).eq("account_id", ctx.accountId).order("created_at", { ascending: true }),
      ctx.supabase.from("incident_activity").select("*").eq("incident_id", id).eq("account_id", ctx.accountId).order("created_at", { ascending: true }),
      ctx.supabase.from("incident_attachments").select("*").eq("incident_id", id).eq("account_id", ctx.accountId).order("created_at", { ascending: true }),
      ctx.supabase.from("incident_notifications_sent").select("*").eq("incident_id", id).eq("account_id", ctx.accountId).order("sent_at", { ascending: false }),
      ctx.supabase.from("incident_actions").select("*").eq("incident_id", id).eq("account_id", ctx.accountId).order("created_at", { ascending: true }),
      ctx.supabase.from("incident_obligations").select("*").eq("incident_id", id).eq("account_id", ctx.accountId).order("due_at", { ascending: true }),
    ]);

    if (!inc.data) return NextResponse.json({ error: "not_found" }, { status: 404 });

    return NextResponse.json({
      incident: inc.data,
      comments: com.data ?? [],
      activity: act.data ?? [],
      attachments: att.data ?? [],
      notificationsSent: ns.data ?? [],
      actions: ac.data ?? [],
      obligations: ob.data ?? [],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
