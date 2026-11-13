// POST /api/public/incident-approval — apply a one-tap approve or reject decision from an email link.
// No login: the signed token names one approval row and encodes the decision.
// GET  /api/public/incident-approval?token=... — load the approval context (school, incident, what it is for) so the page can show it.
import { NextResponse } from "next/server";

import { verifyApprovalToken } from "@/lib/incidents/platform/engine";
import { createAdminPgDb } from "@/lib/postgres/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { labelOf } from "@/lib/incidents/platform/roles";

function ip(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function GET(request: Request) {
  const limit = checkRateLimit(`incident-approval-get:${ip(request)}`, { limit: 30, windowMs: 60_000 });
  if (!limit.success) return NextResponse.json({ error: "Too many tries. Wait a minute." }, { status: 429 });

  const { searchParams } = new URL(request.url);
  const token = (searchParams.get("token") ?? "").slice(0, 300);
  const parsed = token ? verifyApprovalToken(token) : null;
  if (!parsed) return NextResponse.json({ error: "This link is not valid." }, { status: 404 });

  const db = createAdminPgDb();
  const { data: row } = await db
    .from("incident_approvals")
    .select("id, incident_id, role_key, for_status, decision, account_id")
    .eq("id", parsed.approvalId)
    .maybeSingle();
  const approval = row as { id: string; incident_id: string; role_key: string; for_status: string | null; decision: string | null; account_id: string } | null;
  if (!approval) return NextResponse.json({ error: "This link is not valid." }, { status: 404 });

  const [incRow, roleRow, acctRow] = await Promise.all([
    db.from("incidents").select("incident_number, created_at").eq("id", approval.incident_id).maybeSingle(),
    db.from("incident_roles").select("name").eq("account_id", approval.account_id).eq("key", approval.role_key).maybeSingle(),
    db.from("accounts").select("brand_name, name").eq("id", approval.account_id).maybeSingle(),
  ]);
  const inc = incRow.data as { incident_number: number; created_at: string } | null;
  const reference = inc ? `INC-${new Date(inc.created_at).getFullYear()}-${inc.incident_number}` : parsed.approvalId;
  const roleName = labelOf((roleRow.data as { name: Record<string, string> } | null)?.name);
  const acct = acctRow.data as { brand_name: string | null; name: string | null } | null;

  return NextResponse.json({
    approvalId: approval.id,
    decision: parsed.decision,
    reference,
    roleName,
    forStatus: approval.for_status,
    alreadyDecided: approval.decision !== null,
    schoolName: acct?.brand_name || acct?.name || null,
  });
}

export async function POST(request: Request) {
  const limit = checkRateLimit(`incident-approval-post:${ip(request)}`, { limit: 20, windowMs: 60_000 });
  if (!limit.success) return NextResponse.json({ error: "Too many tries. Wait a minute." }, { status: 429 });

  const body = (await request.json().catch(() => null)) as { token?: unknown; note?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.slice(0, 300) : "";
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : null;
  const parsed = token ? verifyApprovalToken(token) : null;
  if (!parsed) return NextResponse.json({ error: "This link is not valid." }, { status: 404 });

  if (parsed.decision === "r" && !note) {
    return NextResponse.json({ error: "Please say why you are not approving, so it can be put right." }, { status: 400 });
  }

  const db = createAdminPgDb();
  const { data: row } = await db
    .from("incident_approvals")
    .select("id, decision, account_id, incident_id")
    .eq("id", parsed.approvalId)
    .maybeSingle();
  const approval = row as { id: string; decision: string | null; account_id: string; incident_id: string } | null;
  if (!approval) return NextResponse.json({ error: "This link is not valid." }, { status: 404 });
  if (approval.decision !== null) return NextResponse.json({ ok: true, duplicate: true });

  const decision = parsed.decision === "a" ? "approved" : "rejected";
  const { error } = await db
    .from("incident_approvals")
    .update({ decision, decided_at: new Date().toISOString(), note })
    .eq("id", approval.id)
    .is("decision", null);
  if (error) return NextResponse.json({ error: "Could not record your answer." }, { status: 500 });

  return NextResponse.json({ ok: true });
}
