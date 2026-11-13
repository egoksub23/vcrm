// POST /api/public/incident-email-in/<token> — turn an email into an incident. A mail service (a forwarding rule, a webhook from the school's mail provider, an
// automation) posts the email as JSON: { from, subject, text, message_id? }. No login: the long random address IS the key. Only senders the school listed are
// accepted, and the same message id twice files once. An unknown or switched-off address answers 404 and says nothing else.
import { NextResponse } from "next/server";

import { parseEmailIn } from "@/lib/incidents/platform/email-intake";
import { fileIncidentFromEmail } from "@/lib/incidents/platform/channels-write";
import { processIncidentEvent } from "@/lib/incidents/platform/run";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkRateLimit(`incident-email-in:${ip}`, { limit: 60, windowMs: 60_000 });
  if (!limit.success) return NextResponse.json({ error: "Too many requests." }, { status: 429 });

  // An email with a long body is still small next to this; anything bigger is not a plain email.
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 1_000_000) return NextResponse.json({ error: "Too large." }, { status: 413 });

  const mail = parseEmailIn(await request.json().catch(() => null));
  if (!mail) return NextResponse.json({ error: "Send { from, subject, text } as JSON." }, { status: 400 });

  try {
    const filed = await fileIncidentFromEmail(token, mail);
    switch (filed.status) {
      case "unknown":
        return NextResponse.json({ error: "Not found." }, { status: 404 });
      case "forbidden":
        return NextResponse.json({ error: "That sender is not allowed." }, { status: 403 });
      case "not_ready":
        return NextResponse.json({ error: filed.reason }, { status: 422 });
      case "duplicate":
        return NextResponse.json({ ok: true, duplicate: true, reference: filed.reference });
      case "created":
        // The school's "raised" rules run exactly as for an incident raised on screen. Never allowed to fail the filing.
        await processIncidentEvent(filed.incidentId, "raised");
        return NextResponse.json({ ok: true, reference: filed.reference }, { status: 201 });
    }
  } catch (err) {
    console.error("[incident-email-in] failed:", err);
    return NextResponse.json({ error: "Could not file the incident." }, { status: 500 });
  }
}
