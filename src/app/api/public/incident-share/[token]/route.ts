// GET /api/public/incident-share/[token] — load the public-safe fields of a shared incident.
// No login: the signed share token names the incident and carries an expiry.
import { NextResponse } from "next/server";

import { verifyShareToken } from "@/lib/incidents/platform/share-links";
import { createAdminPgDb } from "@/lib/postgres/db";
import { checkRateLimit } from "@/lib/rate-limit";

type Params = { params: Promise<{ token: string }> };

export async function GET(request: Request, { params }: Params) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkRateLimit(`incident-share:${ip}`, { limit: 60, windowMs: 60_000 });
  if (!limit.success) return NextResponse.json({ error: "Too many tries." }, { status: 429 });

  const { token } = await params;
  const verified = verifyShareToken(token.slice(0, 300));
  if (!verified) return NextResponse.json({ error: "This link is not valid or has expired." }, { status: 404 });

  const db = createAdminPgDb();
  const { data: inc } = await db
    .from("incidents")
    .select("id, account_id, incident_number, created_at, title, incident_type, severity, status, description, standard_id")
    .eq("id", verified.incidentId)
    .maybeSingle();
  const row = inc as {
    id: string; account_id: string; incident_number: number; created_at: string;
    title: string; incident_type: string; severity: string; status: string;
    description: string | null; standard_id: string | null;
  } | null;
  if (!row) return NextResponse.json({ error: "This link is not valid or has expired." }, { status: 404 });

  // Resolve human-readable category and severity names.
  let categoryName = row.incident_type;
  let severityName = row.severity;
  if (row.standard_id) {
    const [cat, sev] = await Promise.all([
      db.from("incident_type_catalogue").select("name").eq("standard_id", row.standard_id).eq("code", row.incident_type).maybeSingle(),
      db.from("incident_severity_levels").select("label").eq("standard_id", row.standard_id).eq("slug", row.severity).maybeSingle(),
    ]);
    categoryName = (cat.data as { name: string } | null)?.name ?? categoryName;
    severityName = (sev.data as { label: string } | null)?.label ?? severityName;
  }

  const { data: acct } = await db.from("accounts").select("brand_name, name").eq("id", row.account_id).maybeSingle();
  const account = acct as { brand_name: string | null; name: string | null } | null;

  return NextResponse.json(
    {
      reference: `INC-${new Date(row.created_at).getFullYear()}-${row.incident_number}`,
      title: row.title,
      categoryName,
      severityName,
      status: row.status,
      createdAt: row.created_at,
      description: row.description,
      schoolName: account?.brand_name || account?.name || null,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
