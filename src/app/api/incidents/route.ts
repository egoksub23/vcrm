// ============================================================
// POST /api/incidents — raise a new incident.
//
// A server route rather than a direct client insert (unlike tickets)
// because raising an incident should also send an email to whoever the
// notify_incident_raised trigger (migration 116) already notified
// in-app — and only server code can call Resend. The trigger itself
// still does the real recipient selection (Compliance Officer /
// incident lead / Admin-Owner fallback); this route just reads back who
// it notified (the notifications rows it inserted) and emails them.
//
// GET lists the incidents the caller may see (RLS decides), with the students named on each so the dashboard can filter by person. The names are read as the
// caller too, so a student on an incident the caller cannot open never shows up.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, requireCapability, toErrorResponse } from "@/lib/auth/account";
import { notifyIncidentEmail } from "@/lib/email/incident-notification-email";
import { accountHasRaisedRules, processIncidentEvent } from "@/lib/incidents/platform/run";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { INCIDENT_DETECTION_SOURCES, isIncidentFlag } from "@/lib/incidents/constants";
import { parseInjuryDetails } from "@/lib/incidents/platform/injury-details";
import { createAdminPgDb } from "@/lib/postgres/db";
import { LIST_PAGE_SIZE } from "@/lib/incidents/constants";

const MAX_TITLE_LEN = 200;
const MAX_DESCRIPTION_LEN = 10000;

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("incidents")
      .select("*")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: false })
      .limit(LIST_PAGE_SIZE);
    if (error) {
      console.error("[GET /api/incidents] fetch error:", error);
      return NextResponse.json({ error: "Failed to load incidents" }, { status: 500 });
    }
    const incidents = (data ?? []) as { id: string }[];
    const involved: Record<string, { name: string; class_name: string | null }[]> = {};
    if (incidents.length > 0) {
      const people = await ctx.supabase
        .from("incident_involved")
        .select("incident_id, name, class_name")
        .in("incident_id", incidents.map((i) => i.id));
      for (const p of (people.data ?? []) as { incident_id: string; name: string; class_name: string | null }[]) {
        (involved[p.incident_id] ??= []).push({ name: p.name, class_name: p.class_name });
      }
    }
    return NextResponse.json({ incidents: data ?? [], involved });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("incidents.raise");

    const limit = checkRateLimit(`incidents:raise:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | {
          title?: unknown;
          description?: unknown;
          incidentType?: unknown;
          severity?: unknown;
          detectionSource?: unknown;
          flags?: unknown;
          details?: unknown;
        }
      | null;

    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title) {
      return NextResponse.json({ error: "'title' is required" }, { status: 400 });
    }
    if (title.length > MAX_TITLE_LEN) {
      return NextResponse.json({ error: `'title' must be ${MAX_TITLE_LEN} characters or fewer` }, { status: 400 });
    }

    const description =
      typeof body?.description === "string" && body.description.trim() !== ""
        ? body.description.trim().slice(0, MAX_DESCRIPTION_LEN)
        : null;

    const incidentType = typeof body?.incidentType === "string" ? body.incidentType : "";
    if (!incidentType) {
      return NextResponse.json({ error: "'incidentType' is required" }, { status: 400 });
    }

    // Validate incidentType and severity against the account's active template.
    // (Frameworks such as PDPA are active alongside it but add obligations, not categories.)
    const { data: activeRows } = await ctx.supabase
      .from("account_incident_standards")
      .select("standard_id")
      .eq("account_id", ctx.accountId)
      .eq("is_active", true);
    const activeIds = (activeRows ?? []).map((r: { standard_id: string }) => r.standard_id);

    const { data: templateRows } = activeIds.length
      ? await ctx.supabase
          .from("incident_standards")
          .select("id")
          .in("id", activeIds)
          .eq("kind", "template")
          .limit(1)
      : { data: [] as { id: string }[] };

    const standardId = templateRows?.[0]?.id as string | undefined;
    if (!standardId) {
      return NextResponse.json({ error: "No active incident standard configured for this account" }, { status: 422 });
    }

    const { data: typeRow } = await ctx.supabase
      .from("incident_type_catalogue")
      .select("id, default_flags, is_hidden")
      .eq("standard_id", standardId)
      .eq("code", incidentType)
      .maybeSingle();

    if (!typeRow) {
      return NextResponse.json({ error: "'incidentType' is not a recognized incident type" }, { status: 400 });
    }
    // A category the school has hidden is not offered any more (the coach portal's report form still files under it).
    if ((typeRow as { is_hidden?: boolean }).is_hidden === true) {
      return NextResponse.json({ error: "That category is not available any more. Pick another." }, { status: 400 });
    }

    const { data: levels } = await ctx.supabase
      .from("incident_severity_levels")
      .select("slug")
      .eq("standard_id", standardId)
      .order("position");
    const levelSlugs = (levels ?? []).map((l: { slug: string }) => l.slug);

    // Default to the second-lowest level (BNM: P3) when the client sends none.
    const severity =
      typeof body?.severity === "string"
        ? body.severity
        : (levelSlugs[Math.max(0, levelSlugs.length - 2)] ?? "");
    if (!levelSlugs.includes(severity)) {
      return NextResponse.json({ error: "'severity' is not a recognized severity level for this standard" }, { status: 400 });
    }

    // Flags say what the incident involves; an active framework's obligations key off them.
    // The client sends the final set (the category's defaults, as the reporter adjusted
    // them); without one the category's own defaults apply.
    let flags: string[];
    if (body?.flags === undefined) {
      flags = (typeRow.default_flags as string[] | null) ?? [];
    } else if (Array.isArray(body.flags) && body.flags.every(isIncidentFlag)) {
      flags = [...new Set(body.flags as string[])];
    } else {
      return NextResponse.json({ error: "'flags' contains an unrecognized flag" }, { status: 400 });
    }

    // Injury details (who was hurt, the activity, where on the body ...) are optional and only make sense for an injury; they are stored where the coach
    // form's answers are, so both entrances read the same.
    const parsedDetails = parseInjuryDetails(body?.details);
    if (!parsedDetails.ok) return NextResponse.json({ error: parsedDetails.error }, { status: 400 });
    const details = parsedDetails.value;
    if (details?.concussion && !flags.includes("concussion") && isIncidentFlag("concussion")) flags = [...flags, "concussion"];

    const detectionSource = typeof body?.detectionSource === "string" ? body.detectionSource : "other";
    if (!INCIDENT_DETECTION_SOURCES.some((d) => d.value === detectionSource)) {
      return NextResponse.json({ error: "'detectionSource' is not recognized" }, { status: 400 });
    }

    const { data: incidentNumber, error: seqError } = await ctx.supabase.rpc("next_incident_number", {
      p_account_id: ctx.accountId,
    });
    if (seqError || incidentNumber == null) {
      console.error("[POST /api/incidents] next_incident_number error:", seqError);
      return NextResponse.json({ error: "Failed to raise incident" }, { status: 500 });
    }

    const { data: inserted, error: insertError } = await ctx.supabase
      .from("incidents")
      .insert({
        account_id: ctx.accountId,
        incident_number: incidentNumber,
        title,
        description,
        incident_type: incidentType,
        severity,
        detection_source: detectionSource,
        reporter_id: ctx.userId,
        standard_id: standardId,
        incident_flags: flags,
        ...(details?.activity ? { activity: details.activity } : {}),
        ...(details && Object.keys(details.customFields).length > 0 ? { custom_fields: details.customFields } : {}),
      })
      .select("*")
      .single();

    if (insertError || !inserted) {
      console.error("[POST /api/incidents] insert error:", insertError);
      return NextResponse.json({ error: "Failed to raise incident" }, { status: 500 });
    }

    // The people named. A person raising an incident cannot write this table themselves (it holds children's details), so the server does, after the checks above.
    if (details && details.people.length > 0) {
      const { error: peopleError } = await createAdminPgDb()
        .from("incident_involved")
        .insert(details.people.map((p) => ({ incident_id: inserted.id, account_id: ctx.accountId, name: p.name, class_name: p.class_name, involvement: "injured" })));
      if (peopleError) console.error("[POST /api/incidents] people insert error:", peopleError);
    }

    // Best-effort email on top of the in-app notification the raise
    // trigger already inserted — read back exactly who it notified
    // rather than re-deriving recipients here.
    // When the school has notification rules switched on, the rules decide who is told (by role), so the old "email every manager" message is not sent as well.
    const rulesDecide = await accountHasRaisedRules(ctx.accountId);
    const appBaseUrl = process.env.NEXT_PUBLIC_SITE_URL;
    if (appBaseUrl && !rulesDecide) {
      const { data: notifiedRows } = await ctx.supabase
        .from("notifications")
        .select("user_id")
        .eq("incident_id", inserted.id)
        .eq("type", "incident_raised");
      const userIds = (notifiedRows ?? []) .map((r: any) => (r as { user_id: string }).user_id);
      const key = `INC-${new Date(inserted.created_at as string).getFullYear()}-${inserted.incident_number}`;
      try {
        await notifyIncidentEmail({
          userIds,
          kind: "raised",
          key,
          title: inserted.title as string,
          severity: inserted.severity as string,
          incidentId: inserted.id as string,
          appBaseUrl,
        });
      } catch (err) {
        console.error("[POST /api/incidents] notify email error:", err);
      }
    }

    // Role-based notices (migration 208/209): never throws, and a problem shows in the incident's message log.
    await processIncidentEvent(inserted.id as string, "raised");

    return NextResponse.json({ incident: inserted }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
