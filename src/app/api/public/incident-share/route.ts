// GET /api/public/incident-share?token=<token> — read a limited, public-safe summary of one incident.
// No login required. Returns only: reference, category, severity, status, raised date, and optional description.
// No names, no attachments, no medical detail, no involved persons.
import { NextResponse } from "next/server";

import { createAdminPgDb } from "@/lib/postgres/db";
import { verifyShareToken } from "@/lib/incidents/platform/share-links";
import { incidentKey } from "@/lib/incidents/types";
import { checkRateLimit } from "@/lib/rate-limit";

export async function GET(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkRateLimit(`incident-share:${ip}`, { limit: 60, windowMs: 60_000 });
  if (!limit.success) return NextResponse.json({ error: "Too many requests. Wait a minute and try again." }, { status: 429 });

  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const verified = token ? verifyShareToken(token) : null;
  if (!verified) return NextResponse.json({ error: "This link is not valid or has expired." }, { status: 404 });

  const db = createAdminPgDb();
  const { data: inc } = await db
    .from("incidents")
    .select("id, account_id, incident_number, created_at, incident_type, severity, status, description, standard_id, is_test")
    .eq("id", verified.incidentId)
    .maybeSingle();
  if (!inc) return NextResponse.json({ error: "This link is not valid or has expired." }, { status: 404 });
  const i = inc as { id: string; account_id: string; incident_number: number; created_at: string; incident_type: string; severity: string; status: string; description: string | null; standard_id: string | null; is_test: boolean };

  let categoryName = i.incident_type;
  let severityName = i.severity;

  if (i.standard_id) {
    const [cat, sev] = await Promise.all([
      db.from("incident_type_catalogue").select("name").eq("standard_id", i.standard_id).eq("code", i.incident_type).maybeSingle(),
      db.from("incident_severity_levels").select("label").eq("standard_id", i.standard_id).eq("slug", i.severity).maybeSingle(),
    ]);
    categoryName = (cat.data as { name: string } | null)?.name ?? categoryName;
    severityName = (sev.data as { label: string } | null)?.label ?? severityName;
  }

  const { data: acct } = await db.from("accounts").select("brand_name, name").eq("id", i.account_id).maybeSingle();
  const school = acct as { brand_name: string | null; name: string | null } | null;

  return NextResponse.json(
    {
      reference: incidentKey(i),
      school_name: school?.brand_name || school?.name || null,
      category: categoryName,
      severity: severityName,
      status: i.status,
      raised_at: i.created_at,
      description: i.description || null,
      expires_at: verified.expiresAt.toISOString(),
      is_test: i.is_test,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
