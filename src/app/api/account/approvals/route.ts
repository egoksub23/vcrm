// ============================================================
// GET /api/account/approvals  (approvals.review)
//
// The approvals queue (Settings > Approvals).
//   ?tab=pending|decided   (default pending)
//   ?type=tag|label|snippet|article
//   ?proposer=<user id>
//   ?since=<ISO date>      (decided tab; never older than 90 days)
//   ?limit=<n>             (max 500)
//
// A thin wrapper over approvals_list(), which checks approvals.review and
// the account itself. Pending = everything waiting for a decision (tags,
// labels, snippets, and knowledge drafts written by people who cannot
// publish). Decided = approvals and rejections of the last 90 days.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { approvalErrorResponse } from "@/lib/approvals/server";

const TABS = new Set(["pending", "decided"]);
const TYPES = new Set(["tag", "label", "snippet", "article"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability("approvals.review");
    const sp = new URL(request.url).searchParams;

    const tab = sp.get("tab") ?? "pending";
    if (!TABS.has(tab)) {
      return NextResponse.json({ error: "'tab' must be pending or decided" }, { status: 400 });
    }
    const type = sp.get("type");
    if (type && !TYPES.has(type)) {
      return NextResponse.json(
        { error: "'type' must be tag, label, snippet or article" },
        { status: 400 },
      );
    }
    const proposer = sp.get("proposer");
    if (proposer && !UUID.test(proposer)) {
      return NextResponse.json({ error: "'proposer' must be a user id" }, { status: 400 });
    }
    const sinceRaw = sp.get("since");
    let since: string | null = null;
    if (sinceRaw) {
      const d = new Date(sinceRaw);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: "'since' must be a date" }, { status: 400 });
      }
      since = d.toISOString();
    }
    const limitRaw = Number(sp.get("limit") ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 200;

    const { data, error } = await ctx.supabase.rpc("approvals_list", {
      p_tab: tab,
      p_type: type || null,
      p_proposer: proposer || null,
      p_since: since,
      p_limit: limit,
    });
    if (error) return approvalErrorResponse(error);

    return NextResponse.json({ items: Array.isArray(data) ? data : [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
