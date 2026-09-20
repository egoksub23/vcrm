// ============================================================
// GET /api/account/audit  (audit.view)
//
// The account's audit log, newest first (migration 082).
//   ?actor=<user id | system | automation | api>
//   ?action=<created | updated | deleted | ...>
//   ?entity_type=<tag | snippet | article | ...>
//   ?from=<date>&to=<date>     time window
//   ?q=<text>                  search the item's name
//   ?limit=50                  page size (1..100)
//   ?cursor=<nextCursor>       the next page
//
// Read through the caller's own Supabase client: the RLS policy on
// `audit_log` (has_capability(account_id, 'audit.view')) is the gate,
// requireCapability is the friendly early refusal.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import {
  applyAuditFilters,
  decodeCursor,
  encodeCursor,
  parseAuditFilters,
} from "@/lib/audit/filters";
import { loadActorNames, loadExistingIds, toAuditEntry } from "@/lib/audit/entries";
import { AUDIT_ROW_COLUMNS, type AuditRow } from "@/lib/audit/types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("audit.view");
    const params = new URL(request.url).searchParams;

    const parsed = parseAuditFilters(params);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const cursor = decodeCursor(params.get("cursor"));
    if (cursor === "invalid") {
      return NextResponse.json({ error: "'cursor' is not valid" }, { status: 400 });
    }

    const limitRaw = Number(params.get("limit"));
    const limit =
      Number.isInteger(limitRaw) && limitRaw >= 1
        ? Math.min(limitRaw, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const query = applyAuditFilters(
      ctx.supabase
        .from("audit_log")
        .select(AUDIT_ROW_COLUMNS)
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1),
      parsed.filters,
      cursor,
    );

    const { data, error } = await query;
    if (error) {
      console.error("[GET /api/account/audit] fetch error:", error);
      return NextResponse.json({ error: "Failed to load the audit log" }, { status: 500 });
    }

    const rows = (data ?? []) as unknown as AuditRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const [names, existing] = await Promise.all([
      loadActorNames(
        ctx.supabase,
        ctx.accountId,
        page.map((r) => r.actor_id).filter((v): v is string => !!v),
      ),
      loadExistingIds(ctx.supabase, page),
    ]);

    const last = page[page.length - 1];
    return NextResponse.json(
      {
        entries: page.map((r) => toAuditEntry(r, names, existing)),
        nextCursor:
          hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
