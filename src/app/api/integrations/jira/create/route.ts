// ============================================================
// POST /api/integrations/jira/create — "Create issue" on a ticket.
//
//   { ticketId, choices: { projectKey, issueTypeId, issueTypeName?,
//                          priorityName?, extraLabels?, assigneeAccountId? },
//     fieldValues?: { <fieldId>: value }, preview?: true }
//
//   preview: true  -> { preview, required, previewRequired }: exactly what
//                     would be sent (customer name and email left out unless
//                     an admin turned that on) and which required fields the
//                     dialog must still ask for. Nothing is written.
//   otherwise      -> creates the issue, stores the link, adds the "Vircle
//                     ticket" back link in Jira, logs activity and audit.
//
// Needs jira.link.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability } from "@/lib/auth/account";
import { apiErrorResponse, ApiError, loadJiraContext } from "@/lib/jira/http";
import { ensureWebhooks } from "@/lib/jira/connection";
import { createIssueFromTicket, previewCreate } from "@/lib/jira/links";
import { readWebhookToken } from "@/lib/jira/service";
import { isProjectKey } from "@/lib/jira/settings";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import type { CreateChoices } from "@/lib/jira/create-issue";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseChoices(v: unknown): CreateChoices {
  const c = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  if (!isProjectKey(c.projectKey)) throw new ApiError(400, "bad_request", "Choose a project");
  if (typeof c.issueTypeId !== "string" || !/^\d{1,20}$/.test(c.issueTypeId)) throw new ApiError(400, "bad_request", "Choose an issue type");
  const str = (x: unknown, max: number) => (typeof x === "string" && x.trim() && x.length <= max ? x.trim() : undefined);
  return {
    projectKey: c.projectKey.toUpperCase(),
    issueTypeId: c.issueTypeId,
    issueTypeName: str(c.issueTypeName, 80),
    priorityName: str(c.priorityName, 80) ?? null,
    extraLabels: Array.isArray(c.extraLabels) ? c.extraLabels.filter((l): l is string => typeof l === "string").slice(0, 10) : [],
    assigneeAccountId: str(c.assigneeAccountId, 128) ?? null,
  };
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("jira.link");
    const limit = checkRateLimit(`jira:create:${ctx.userId}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.ticketId !== "string" || !UUID.test(body.ticketId)) throw new ApiError(400, "bad_request", "ticketId is required");
    const choices = parseChoices(body.choices);

    const j = await loadJiraContext(ctx, request);
    // The caller must be able to see the ticket (RLS on their own session).
    const { data: visible } = await ctx.supabase.from("tickets").select("id, contact_id").eq("id", body.ticketId).maybeSingle();
    if (!visible) throw new ApiError(404, "not_found", "Ticket not found");

    let customer: { name: string | null; email: string | null } | null = null;
    if (j.sync.settings.privacy.include_customer) {
      const { data } = await j.db.from("contacts").select("name, email").eq("id", (visible as { contact_id: string }).contact_id).maybeSingle();
      customer = (data as { name: string | null; email: string | null } | null) ?? null;
    }

    if (body.preview === true) {
      const { plan, required } = await previewCreate(j.sync, { ticketId: body.ticketId, choices, customer });
      return NextResponse.json({
        preview: plan.preview,
        required: {
          ask: required.ask.map(({ field, kind }) => ({
            id: field.key ?? field.fieldId,
            name: field.name,
            kind,
            options: (field.allowedValues ?? []).map((v) => ({ id: v.id ?? "", name: v.name ?? v.value ?? v.key ?? "" })).filter((o) => o.id),
          })),
          unsupported: required.unsupported.map((f) => f.name),
        },
        // Whether this workspace shows the preview before sending (Settings > Jira > Privacy).
        previewRequired: j.sync.settings.privacy.preview_before_send,
      });
    }

    const raw = body.fieldValues && typeof body.fieldValues === "object" ? (body.fieldValues as Record<string, unknown>) : {};
    const link = await createIssueFromTicket(j.sync, {
      ticketId: body.ticketId,
      choices,
      rawFieldValues: raw,
      customer,
      userId: ctx.userId,
    });

    // The first link needs a webhook (the daily job keeps it after that); never blocks the answer.
    if (Array.isArray(j.connection.webhook_ids) && j.connection.webhook_ids.length === 0) {
      const token = await readWebhookToken(j.db, j.connection.id);
      if (token) {
        const fresh = await j.store.getConnection(j.connection.id);
        if (fresh) {
          void ensureWebhooks({ db: j.db, store: j.store, client: j.client, connection: fresh, baseUrl: j.sync.appUrl, webhookToken: token }).catch(() => undefined);
        }
      }
    }
    return NextResponse.json({ link }, { status: 201 });
  } catch (err) {
    return apiErrorResponse(err);
  }
}
