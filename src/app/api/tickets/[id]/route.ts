import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

type Params = { params: Promise<{ id: string }> };

const SELECT = "*, contact:contacts(id, name, phone, wa_username, wa_user_id), comments:ticket_comments(count)";

export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;

    const [ticketRes, commentRes, activityRes, watcherRes, attachmentRes] = await Promise.all([
      ctx.supabase.from("tickets").select(SELECT).eq("id", id).eq("account_id", ctx.accountId).maybeSingle(),
      ctx.supabase.from("ticket_comments").select("*").eq("ticket_id", id).order("created_at", { ascending: true }),
      ctx.supabase.from("ticket_activity").select("*").eq("ticket_id", id).order("created_at", { ascending: true }),
      ctx.supabase.from("ticket_watchers").select("*").eq("ticket_id", id).order("created_at", { ascending: true }),
      ctx.supabase.from("ticket_attachments").select("*").eq("ticket_id", id).order("created_at", { ascending: true }),
    ]);

    if (!ticketRes.data) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const ticket = ticketRes.data as Record<string, unknown>;
    const links: unknown[] = [];
    const linked: Record<string, unknown> = {};

    const { data: linkRows } = await ctx.supabase
      .from("ticket_links")
      .select("*")
      .or(`from_ticket_id.eq.${id},to_ticket_id.eq.${id}`)
      .order("created_at", { ascending: true });

    if (linkRows && linkRows.length > 0) {
      links.push(...linkRows);
      const missing = [
        ...new Set(
          (linkRows as { from_ticket_id: string; to_ticket_id: string }[])
            .flatMap((l) => [l.from_ticket_id, l.to_ticket_id])
            .filter((x) => x !== id),
        ),
      ];
      if (missing.length > 0) {
        const { data: others } = await ctx.supabase
          .from("tickets")
          .select("id, ticket_number, subject, status, category")
          .in("id", missing);
        for (const o of (others as { id: string }[] | null) ?? []) {
          linked[(o as { id: string }).id] = o;
        }
      }
    }

    let contact: unknown = null;
    const contactId = (ticket as { contact_id?: string }).contact_id;
    if (contactId) {
      const { data: contactRow } = await ctx.supabase.from("contacts").select("*").eq("id", contactId).maybeSingle();
      contact = contactRow ?? null;
    }

    return NextResponse.json({
      ticket,
      contact,
      comments: commentRes.data ?? [],
      activity: activityRes.data ?? [],
      watchers: watcherRes.data ?? [],
      attachments: attachmentRes.data ?? [],
      links,
      linked,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const { error } = await ctx.supabase
      .from("tickets")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
