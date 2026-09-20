// ============================================================
// POST /api/integrations/jira/webhook/[token]
//
// Where Jira delivers its dynamic webhooks. PUBLIC by necessity: the random
// per-connection token in the path (plus the signed bearer when Jira sends
// one) is the authentication; see src/lib/jira/webhook.ts for exactly what is
// checked and what is unconfirmed. It verifies, de-duplicates, queues a
// "sync issue X" job and answers 200 fast. It never acts on the payload:
// the worker re-reads the issue from Jira.
//
// Not covered by requireCapability on purpose (there is no signed-in user).
// ============================================================

import { NextResponse } from "next/server";

import { jiraStore, supabaseWebhookStore } from "@/lib/jira/service";
import { handleWebhook } from "@/lib/jira/webhook-handler";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const rawBody = await request.text();
    const result = await handleWebhook(
      {
        pathToken: token,
        authorization: request.headers.get("authorization"),
        identifier: request.headers.get("x-atlassian-webhook-identifier"),
        rawBody,
        clientSecret: process.env.JIRA_CLIENT_SECRET?.trim() || null,
        verifyMode: process.env.JIRA_WEBHOOK_VERIFY?.trim() || null,
      },
      { hooks: supabaseWebhookStore(), store: jiraStore() },
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    // A 5xx makes Jira retry, which is what we want for a transient database problem.
    console.error("[jira webhook] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
