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
// GET is not needed here — the list/board/detail views read `incidents`
// directly via the browser Supabase client, same as Tickets; RLS alone
// decides what each caller can see.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { notifyIncidentEmail } from "@/lib/email/incident-notification-email";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { INCIDENT_SEVERITIES, INCIDENT_TYPES, INCIDENT_DETECTION_SOURCES } from "@/lib/incidents/constants";

const MAX_TITLE_LEN = 200;
const MAX_DESCRIPTION_LEN = 10000;

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

    const incidentType = body?.incidentType;
    if (typeof incidentType !== "string" || !INCIDENT_TYPES.some((t) => t.code === incidentType)) {
      return NextResponse.json({ error: "'incidentType' is not a recognized incident type" }, { status: 400 });
    }

    const severity = typeof body?.severity === "string" ? body.severity : "P3";
    if (!INCIDENT_SEVERITIES.includes(severity as (typeof INCIDENT_SEVERITIES)[number])) {
      return NextResponse.json({ error: "'severity' must be one of P1, P2, P3, P4" }, { status: 400 });
    }

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
      })
      .select("*")
      .single();

    if (insertError || !inserted) {
      console.error("[POST /api/incidents] insert error:", insertError);
      return NextResponse.json({ error: "Failed to raise incident" }, { status: 500 });
    }

    // Best-effort email on top of the in-app notification the raise
    // trigger already inserted — read back exactly who it notified
    // rather than re-deriving recipients here.
    const appBaseUrl = process.env.NEXT_PUBLIC_SITE_URL;
    if (appBaseUrl) {
      const { data: notifiedRows } = await ctx.supabase
        .from("notifications")
        .select("user_id")
        .eq("incident_id", inserted.id)
        .eq("type", "incident_raised");
      const userIds = (notifiedRows ?? []).map((r) => (r as { user_id: string }).user_id);
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

    return NextResponse.json({ incident: inserted }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
