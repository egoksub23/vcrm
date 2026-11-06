// POST /api/broadcasts/audience-count
// Body mirrors the BroadcastAudience type. Returns { count: number | null }.
import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      type?: string;
      tagIds?: string[];
      excludeTagIds?: string[];
      csvContacts?: unknown[];
      customField?: { fieldId?: string; operator?: string; value?: string };
    } | null;
    if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });

    const { type, tagIds, excludeTagIds, csvContacts, customField } = body;

    if (type === "csv") {
      return NextResponse.json({ count: csvContacts?.length ?? 0 });
    }

    let baseIds: Set<string> | null = null;

    if (type === "tags" && tagIds && tagIds.length > 0) {
      const { data } = await ctx.supabase
        .from("contact_tags")
        .select("contact_id")
        .eq("account_id", ctx.accountId)
        .in("tag_id", tagIds);
      baseIds = new Set((data ?? []).map((r: { contact_id: string }) => r.contact_id));
    } else if (type === "custom_field" && customField?.fieldId && customField.value) {
      const { fieldId, operator, value } = customField;
      let q = ctx.supabase
        .from("contact_custom_values")
        .select("contact_id")
        .eq("account_id", ctx.accountId)
        .eq("custom_field_id", fieldId);
      if (operator === "is") q = q.eq("value", value);
      else if (operator === "is_not") q = q.neq("value", value);
      else q = q.ilike("value", `%${value}%`);
      const { data } = await q;
      baseIds = new Set((data ?? []).map((r: { contact_id: string }) => r.contact_id));
    } else if (type !== "all") {
      return NextResponse.json({ count: null });
    }

    let excludeSet: Set<string> | null = null;
    if (excludeTagIds && excludeTagIds.length > 0) {
      const { data: excludeRows } = await ctx.supabase
        .from("contact_tags")
        .select("contact_id")
        .eq("account_id", ctx.accountId)
        .in("tag_id", excludeTagIds);
      excludeSet = new Set((excludeRows ?? []).map((r: { contact_id: string }) => r.contact_id));
    }

    if (baseIds !== null) {
      const effective = [...baseIds].filter((id) => !excludeSet?.has(id));
      return NextResponse.json({ count: effective.length });
    }

    // "all" — full table count minus excludes
    const { count } = await ctx.supabase
      .from("contacts")
      .select("*", { count: "exact", head: true })
      .eq("account_id", ctx.accountId);
    const total = count ?? 0;
    return NextResponse.json({ count: excludeSet ? Math.max(0, total - excludeSet.size) : total });
  } catch (err) {
    return toErrorResponse(err);
  }
}
