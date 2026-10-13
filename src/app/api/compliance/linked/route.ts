// ============================================================
// GET /api/compliance/linked?conversationId=...   (any signed-in member; the answer depends on what they hold)
//
// The "Compliance requests" section of the Inbox column (migration 185): the requests linked to this conversation or to its contact.
//
//   a workspace with Compliance off answers { enabled: false, items: [] } to everyone: the section is not drawn
//   a person who holds a compliance permission: every linked request, each as { reference, typeKey, typeLabel, typeLabelL10n, status, raisedAt, id, step }
//   anyone else: only the requests THEY raised, as the raiser's minimal projection { reference, typeKey, typeLabel, typeLabelL10n, status, raisedAt }; no id,
//   no customer, no answer, no bank detail, no reason
//
// The conversation is read with the caller's own session, so a person asks only about a conversation they may open.
// ============================================================
import { getCurrentAccount, loadCapabilities } from "@/lib/auth/account";
import { answer, failure, json, rateLimited, UUID_RE } from "@/lib/compliance/http";
import { linkedRequests } from "@/lib/compliance/service/linked";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { isFeatureEnabled } from "@/lib/platform/features";
import { checkRateLimit } from "@/lib/rate-limit";

const WORK = ["menu.compliance", "compliance.review", "compliance.approve", "compliance.reveal", "compliance.execute", "compliance.manage"] as const;

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const rate = checkRateLimit(`compliance:${ctx.userId}:linked`, { limit: 120, windowMs: 60_000 });
    if (!rate.success) return rateLimited(rate.reset);
    // the operator's switch: off for the workspace, nothing is drawn (the capabilities would be gone too, but a person who raised before it was switched off
    // must not be shown their old rows either)
    if (!isFeatureEnabled(ctx.platform, "compliance")) return json({ enabled: false, items: [] });
    const conversationId = new URL(request.url).searchParams.get("conversationId");
    if (!conversationId || !UUID_RE.test(conversationId)) return failure("invalid_request");
    const caps = await loadCapabilities(ctx);
    const sees = WORK.some((c) => caps.has(c));
    const items = await linkedRequests(supabaseAdmin(), { accountId: ctx.accountId, userId: ctx.userId, userDb: ctx.supabase, sees }, conversationId);
    return json({ enabled: true, items });
  } catch (err) {
    return answer(err);
  }
}
