import { NextResponse } from "next/server";
import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";
import { findExistingContact } from "@/lib/contacts/dedupe";

const COLUMNS = "id, name, email, phone, company";

/** Sanitise a free-text query to avoid characters that break PostgREST filter syntax. */
function safeQuery(q: string) {
  return q.replace(/[,()%*\\"]/g, " ").replace(/\s+/g, " ").trim();
}

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const q = safeQuery(searchParams.get("q") ?? "");
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "8", 10), 50);
    const full = searchParams.get("full") === "true";
    const page = Math.max(0, parseInt(searchParams.get("page") ?? "0", 10));
    const pageSize = Math.min(parseInt(searchParams.get("pageSize") ?? "25", 10), 100);
    const tagIdsParam = searchParams.get("tagIds") ?? null;
    const includeTags = searchParams.get("include_tags") === "true";
    const tagIds = tagIdsParam ? tagIdsParam.split(",").map((s) => s.trim()).filter(Boolean) : null;

    // Paginated contacts page mode — full rows + count + optional tag filter
    if (full) {
      let contacts: Record<string, unknown>[];
      let total: number;

      if (tagIds && tagIds.length > 0) {
        const { data, error } = await ctx.supabase.rpc("filter_contacts_by_tags", {
          p_tag_ids: tagIds,
          p_search: q || null,
          p_limit: pageSize,
          p_offset: page * pageSize,
        });
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        const rows = (data ?? []) as { contact: Record<string, unknown>; total_count: number }[];
        contacts = rows.map((r) => r.contact);
        total = rows.length > 0 ? Number(rows[0].total_count) : 0;
      } else {
        const from = page * pageSize;
        const to = from + pageSize - 1;
        let baseQuery = ctx.supabase
          .from("contacts")
          .select("*", { count: "exact" })
          .eq("account_id", ctx.accountId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .range(from, to);
        if (q) {
          const like = `%${q}%`;
          baseQuery = baseQuery.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
        }
        const { data, count, error } = await baseQuery;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        contacts = (data ?? []) as Record<string, unknown>[];
        total = count ?? 0;
      }

      // Optionally enrich with contact_tags
      if (includeTags && contacts.length > 0) {
        const ids = contacts.map((c) => c.id as string);
        const { data: ctRows } = await ctx.supabase
          .from("contact_tags")
          .select("contact_id, tag_id")
          .eq("account_id", ctx.accountId)
          .in("contact_id", ids);
        const tagsByContact: Record<string, string[]> = {};
        for (const row of (ctRows ?? []) as { contact_id: string; tag_id: string }[]) {
          if (!tagsByContact[row.contact_id]) tagsByContact[row.contact_id] = [];
          tagsByContact[row.contact_id].push(row.tag_id);
        }
        contacts = contacts.map((c) => ({ ...c, _tag_ids: tagsByContact[c.id as string] ?? [] }));
      }

      return NextResponse.json({ contacts, total });
    }

    // Simple list mode (search widget, autocomplete, etc.)
    let query = ctx.supabase.from("contacts").select(COLUMNS).eq("account_id", ctx.accountId).is("deleted_at", null);
    const all = searchParams.get("all") === "true";
    const orderBy = searchParams.get("orderBy") ?? null;
    if (q) {
      query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%,company.ilike.%${q}%`);
    } else if (orderBy === "name") {
      query = query.order("name");
    } else {
      query = query.order("created_at", { ascending: false });
    }
    if (!all) query = query.limit(limit);
    const { data } = await query;
    return NextResponse.json({ contacts: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireCapability("contacts.edit");
    const body = (await request.json().catch(() => null)) as { ids?: string[] } | null;
    const ids = body?.ids ?? [];
    if (!ids.length) return NextResponse.json({ error: "ids required" }, { status: 400 });

    const { error } = await ctx.supabase
      .from("contacts")
      .delete()
      .eq("account_id", ctx.accountId)
      .in("id", ids);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("contacts.edit");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });

    const phone = typeof body.phone === "string" ? body.phone.trim() : null;
    if (!phone) return NextResponse.json({ error: "phone required" }, { status: 400 });

    const { data, error } = await ctx.supabase
      .from("contacts")
      .insert({
        user_id: ctx.userId,
        account_id: ctx.accountId,
        name: typeof body.name === "string" ? body.name.trim() || null : null,
        phone,
        email: typeof body.email === "string" ? body.email.trim() || null : null,
        company: typeof body.company === "string" ? body.company.trim() || null : null,
        lifecycle_stage: typeof body.lifecycle_stage === "string" ? body.lifecycle_stage : "lead",
        lifecycle_stage_changed_at: body.lifecycle_stage_changed_at ?? null,
      })
      .select("id")
      .single();

    if (error) {
      if ((error as { code?: string }).code === "23505") {
        const conflict = await findExistingContact(ctx.supabase as never, ctx.accountId, phone);
        return NextResponse.json({ error: "duplicate_phone", conflict }, { status: 409 });
      }
      if (error.message === "contact_limit_reached") {
        return NextResponse.json({ error: "contact_limit_reached" }, { status: 422 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ contact: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
