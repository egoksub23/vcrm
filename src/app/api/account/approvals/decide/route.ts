// ============================================================
// POST /api/account/approvals/decide  (approvals.review)
//
// One decision:
//   { entity_type: 'tag'|'snippet'|'article', id, decision: 'approve'|'reject',
//     note?, edited? }
// or a bulk approval:
//   { decision: 'approve', items: [{ entity_type, id }, ...] }
//
// A thin wrapper over the decide_proposal RPC, which is the ONLY write path:
// it checks approvals.review, that the item is still pending, that nobody
// decides their own proposal, name conflicts, and writes the audit row and
// the notification. `edited` carries "edit then approve" replacement values.
//
// Approving a knowledge article = publishing it: the RPC also needs
// knowledge.publish, and this route then re-indexes the article exactly as
// the article editor does. A rejected article simply stays a draft, so
// `reject` is refused for articles (open the editor and comment instead).
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { approvalErrorResponse } from "@/lib/approvals/server";
import { indexArticle } from "@/lib/knowledge/articles";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { validateInteractivePayload } from "@/lib/whatsapp/interactive";

const ENTITIES = new Set(["tag", "snippet", "article"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BULK = 100;

interface Target {
  entity_type: string;
  id: string;
}

function isTarget(v: unknown): v is Target {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.entity_type === "string" &&
    ENTITIES.has(t.entity_type) &&
    typeof t.id === "string" &&
    UUID.test(t.id)
  );
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("approvals.review");
    const limit = checkRateLimit(`admin:approvals:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

    const decision = body.decision;
    if (decision !== "approve" && decision !== "reject") {
      return NextResponse.json({ error: "'decision' must be approve or reject" }, { status: 400 });
    }
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (decision === "reject" && note.length < 3) {
      return NextResponse.json({ error: "note_required", code: "note_required" }, { status: 400 });
    }

    // ---- bulk approve -------------------------------------------------
    if (Array.isArray(body.items)) {
      if (decision !== "approve") {
        return NextResponse.json({ error: "Only approvals can be done in bulk" }, { status: 400 });
      }
      const items = body.items as unknown[];
      if (items.length === 0 || items.length > MAX_BULK || !items.every(isTarget)) {
        return NextResponse.json(
          { error: `'items' must list 1 to ${MAX_BULK} items with an entity_type and an id` },
          { status: 400 },
        );
      }
      const results: { id: string; entity_type: string; ok: boolean; code?: string }[] = [];
      for (const t of items as Target[]) {
        const r = await decideOne(ctx, t, "approve", note, null);
        results.push({ id: t.id, entity_type: t.entity_type, ok: r.ok, code: r.code });
      }
      return NextResponse.json({
        results,
        approved: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      });
    }

    // ---- one decision -------------------------------------------------
    if (!isTarget({ entity_type: body.entity_type, id: body.id })) {
      return NextResponse.json({ error: "'entity_type' and 'id' are required" }, { status: 400 });
    }
    const target = { entity_type: body.entity_type as string, id: body.id as string };

    let edited: Record<string, unknown> | null = null;
    if (body.edited !== undefined && body.edited !== null) {
      if (typeof body.edited !== "object" || Array.isArray(body.edited)) {
        return NextResponse.json({ error: "'edited' must be an object" }, { status: 400 });
      }
      if (decision !== "approve") {
        return NextResponse.json({ error: "Only an approval can carry edits" }, { status: 400 });
      }
      edited = body.edited as Record<string, unknown>;
      if (target.entity_type === "snippet" && edited.interactive_payload != null) {
        const v = validateInteractivePayload(edited.interactive_payload);
        if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
      }
    }

    const r = await decideOne(ctx, target, decision, note, edited);
    if (!r.ok) return r.response!;
    return NextResponse.json({ ok: true, ...r.data, warning: r.warning });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function decideOne(
  ctx: Awaited<ReturnType<typeof requireCapability>>,
  target: Target,
  decision: "approve" | "reject",
  note: string,
  edited: Record<string, unknown> | null,
): Promise<{
  ok: boolean;
  code?: string;
  response?: NextResponse;
  data?: Record<string, unknown>;
  warning?: string;
}> {
  const { data, error } = await ctx.supabase.rpc("decide_proposal", {
    p_entity_type: target.entity_type,
    p_id: target.id,
    p_decision: decision,
    p_note: note || null,
    p_edited: edited,
  });
  if (error) {
    const response = approvalErrorResponse(error);
    const code = (await response.clone().json().catch(() => ({}))) as { code?: string };
    return { ok: false, code: code.code, response };
  }

  // An approved article is now published: build its search index.
  let warning: string | undefined;
  if (target.entity_type === "article" && decision === "approve") {
    const { data: doc } = await ctx.supabase
      .from("ai_knowledge_documents")
      .select("id, title, content, status")
      .eq("account_id", ctx.accountId)
      .eq("id", target.id)
      .maybeSingle();
    if (doc) {
      const w = await indexArticle(ctx.supabase, ctx.accountId, {
        id: doc.id as string,
        title: doc.title as string,
        content: doc.content as string,
        status: doc.status as "draft" | "published",
      });
      if (w) warning = w;
    }
  }
  return { ok: true, data: (data ?? {}) as Record<string, unknown>, warning };
}
