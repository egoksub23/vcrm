// ============================================================
// GET /api/account/audit/export  (audit.view)
//
// The audit log as a CSV download. Takes the same filters as
// /api/account/audit (no cursor), streams the file in pages of 1000 and
// stops at 10,000 rows. Cells that start with = + - @ are prefixed with
// an apostrophe so a spreadsheet never runs them as a formula.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import {
  csvEntryLines,
  csvHeaderLine,
  EXPORT_MAX_ROWS,
  EXPORT_PAGE_SIZE,
} from "@/lib/audit/csv";
import { loadActorNames, toAuditEntry } from "@/lib/audit/entries";
import { applyAuditFilters, parseAuditFilters, type AuditCursor } from "@/lib/audit/filters";
import { AUDIT_ROW_COLUMNS, type AuditRow } from "@/lib/audit/types";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("audit.view");
    const limit = checkRateLimit(`audit-export:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const parsed = parseAuditFilters(new URL(request.url).searchParams);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const filters = parsed.filters;

    // Names of everyone in the account, once (a member list is small).
    const { data: people } = await ctx.supabase
      .from("profiles")
      .select("user_id")
      .eq("account_id", ctx.accountId);
    const names = await loadActorNames(
      ctx.supabase,
      ctx.accountId,
      ((people ?? []) as { user_id: string }[]).map((p) => p.user_id),
    );

    const encoder = new TextEncoder();
    let cursor: AuditCursor | null = null;
    let sent = 0;
    let started = false;
    let done = false;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (!started) {
            started = true;
            // BOM so Excel reads non-ASCII names (Korean, accented) as UTF-8.
            controller.enqueue(encoder.encode("﻿" + csvHeaderLine()));
          }
          if (done || sent >= EXPORT_MAX_ROWS) {
            controller.close();
            return;
          }
          const take: number = Math.min(EXPORT_PAGE_SIZE, EXPORT_MAX_ROWS - sent);
          const { data, error } = await applyAuditFilters(
            ctx.supabase
              .from("audit_log")
              .select(AUDIT_ROW_COLUMNS)
              .eq("account_id", ctx.accountId)
              .order("created_at", { ascending: false })
              .order("id", { ascending: false })
              .limit(take),
            filters,
            cursor,
          );
          if (error) throw error;
          const rows = (data ?? []) as unknown as AuditRow[];
          if (rows.length > 0) {
            controller.enqueue(
              encoder.encode(csvEntryLines(rows.map((r) => toAuditEntry(r, names)))),
            );
            sent += rows.length;
            const last = rows[rows.length - 1];
            cursor = { createdAt: last.created_at, id: last.id };
          }
          if (rows.length < take) done = true;
        } catch (err) {
          console.error("[GET /api/account/audit/export] stream error:", err);
          controller.error(err);
        }
      },
    });

    const day = new Date().toISOString().slice(0, 10);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-log-${day}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

