// /api/platform/standards — platform admin editor for incident_standards.
// Lets the operator create new system templates and frameworks without a SQL migration.
//   GET   list all system templates and frameworks
//   POST  { action: "create-template", name, slug?, sector?, regulatory_body?, description? }
//           creates the standard row and seeds 4 default severity levels
//         { action: "create-framework", name, slug?, description? }
//           creates the framework standard row (obligation rules are added separately)
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { createAdminPgDb } from "@/lib/postgres/db";

const NO_STORE = { "Cache-Control": "no-store" };

/** Default severity levels seeded into every new system template. */
const DEFAULT_SEVERITIES = [
  { slug: "critical", label: "P1 Critical", color: "#dc2626", escalate_hrs: 1,  regulatory_hrs: 1,  resolve_days: null, position: 1 },
  { slug: "major",    label: "P2 Major",    color: "#ea580c", escalate_hrs: 4,  regulatory_hrs: 24, resolve_days: 3,   position: 2 },
  { slug: "minor",    label: "P3 Minor",    color: "#ca8a04", escalate_hrs: 24, regulatory_hrs: null, resolve_days: 7, position: 3 },
  { slug: "low",      label: "P4 Low",      color: "#16a34a", escalate_hrs: null, regulatory_hrs: null, resolve_days: 14, position: 4 },
];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "standard";
}

export async function GET() {
  try {
    await requirePlatformAdmin();
    const db = createAdminPgDb();
    const { data } = await db.from("incident_standards").select("id, slug, name, kind, sector, regulatory_body, description, created_at").eq("is_system", true).order("kind").order("name");
    return NextResponse.json(data ?? [], { headers: NO_STORE });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    await requirePlatformAdmin();
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const db = createAdminPgDb();

    if (body?.action === "create-template" || body?.action === "create-framework") {
      const isTemplate = body.action === "create-template";
      const name = typeof body.name === "string" ? body.name.trim() : null;
      if (!name) return NextResponse.json({ error: "Provide a name." }, { status: 400 });

      // Build a unique slug
      const base = typeof body.slug === "string" && body.slug.trim() ? slugify(body.slug.trim()) : slugify(name);
      const { data: existing } = await db.from("incident_standards").select("slug").like("slug", `${base}%`);
      const taken = new Set((existing ?? []).map((r: { slug: string }) => r.slug));
      let slug = base;
      if (taken.has(slug)) {
        for (let i = 2; i < 100; i++) {
          const candidate = `${base}-${i}`;
          if (!taken.has(candidate)) { slug = candidate; break; }
        }
      }

      const row = {
        slug,
        name,
        kind: isTemplate ? "template" : "framework",
        is_system: true,
        account_id: null,
        sector: typeof body.sector === "string" && body.sector.trim() ? body.sector.trim() : null,
        regulatory_body: typeof body.regulatory_body === "string" && body.regulatory_body.trim() ? body.regulatory_body.trim() : null,
        description: typeof body.description === "string" && body.description.trim() ? body.description.trim() : null,
      };

      const { data: created, error } = await db.from("incident_standards").insert(row).select("id").single();
      if (error || !created) {
        console.error("[platform standards create]", error);
        return NextResponse.json({ error: "Could not create the standard." }, { status: 500 });
      }
      const standardId = (created as { id: string }).id;

      if (isTemplate) {
        // Seed default severity levels so the template is immediately usable
        const sevs = DEFAULT_SEVERITIES.map((s) => ({ ...s, standard_id: standardId }));
        const { error: sevErr } = await db.from("incident_severity_levels").insert(sevs);
        if (sevErr) {
          console.error("[platform standards severities]", sevErr);
          // Don't fail — the template is created; admin can add severities manually
        }
      }

      return NextResponse.json({ id: standardId, slug }, { status: 201 });
    }

    return NextResponse.json({ error: "Say what to do: create-template or create-framework." }, { status: 400 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
