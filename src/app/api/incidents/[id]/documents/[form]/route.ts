// ============================================================
// POST /api/incidents/[id]/documents/[form]
//
//   `form` ∈ a|b|c|d. Body is that form's compose-time-only fields (see
//   src/lib/incidents/documents/types.ts) — everything else is pulled
//   straight from the incident record via fetchIncidentDocumentContext.
//   Returns `{ filename, base64, generatedDocumentId }` — always JSON,
//   never a raw binary download, so the client can uniformly decode a
//   Blob for the download AND (if "save as evidence" was checked) build
//   a File from the same bytes and reuse the existing client-side
//   attachFileToIncident() upload path (this route has no server-side
//   storage helper — upload has always been client-direct-to-storage).
// ============================================================
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";
import { fetchIncidentDocumentContext } from "@/lib/incidents/documents/fetch-context";
import { buildFormADocx } from "@/lib/incidents/documents/form-a";
import { buildFormBDocx } from "@/lib/incidents/documents/form-b";
import { buildFormCDocx } from "@/lib/incidents/documents/form-c";
import { buildFormDDocx } from "@/lib/incidents/documents/form-d";
import { incidentKey } from "@/lib/incidents/types";
import type {
  FormAComposeInput,
  FormBComposeInput,
  FormCComposeInput,
  FormDComposeInput,
} from "@/lib/incidents/documents/types";

const FORMS = ["a", "b", "c", "d"] as const;
type Form = (typeof FORMS)[number];

function isForm(v: string): v is Form {
  return (FORMS as readonly string[]).includes(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; form: string }> }) {
  try {
    const ctx = await requireCapability("incidents.manage");
    const { id: incidentId, form } = await params;
    if (!isForm(form)) {
      return NextResponse.json({ error: "form must be one of a, b, c, d" }, { status: 400 });
    }

    const rl = checkRateLimit(`incidents:documents:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!rl.success) return rateLimitResponse(rl);

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !isNonEmptyString(body.preparedByName) || !isNonEmptyString(body.preparedByRole)) {
      return NextResponse.json({ error: "preparedByName and preparedByRole are required" }, { status: 400 });
    }

    const docContext = await fetchIncidentDocumentContext(ctx.supabase, incidentId, ctx.accountId);
    if (!docContext) {
      return NextResponse.json({ error: "Incident not found" }, { status: 404 });
    }

    let buffer: Buffer;
    if (form === "a") {
      if (!Array.isArray(body.recipients) || !Array.isArray(body.otherPartiesNotified)) {
        return NextResponse.json({ error: "recipients and otherPartiesNotified are required arrays" }, { status: 400 });
      }
      buffer = await buildFormADocx(docContext, body as unknown as FormAComposeInput);
    } else if (form === "b") {
      if (!isNonEmptyString(body.executiveSummary) || !Array.isArray(body.timeline) || !body.nextStepsContact) {
        return NextResponse.json({ error: "executiveSummary, timeline and nextStepsContact are required" }, { status: 400 });
      }
      buffer = await buildFormBDocx(docContext, body as unknown as FormBComposeInput);
    } else if (form === "c") {
      if (!Array.isArray(body.timelinessRows)) {
        return NextResponse.json({ error: "timelinessRows must be an array" }, { status: 400 });
      }
      buffer = await buildFormCDocx(docContext, body as unknown as FormCComposeInput);
    } else {
      if (!isNonEmptyString(body.changesSinceLastUpdate) || (body.updateType !== "status_update" && body.updateType !== "final_closure")) {
        return NextResponse.json({ error: "changesSinceLastUpdate and a valid updateType are required" }, { status: 400 });
      }
      buffer = await buildFormDDocx(docContext, body as unknown as FormDComposeInput);
    }

    const filename = `${incidentKey(docContext.incident)}-Form${form.toUpperCase()}.docx`;

    let generatedDocumentId: string | null = null;
    const { data: logged, error: logError } = await ctx.supabase
      .from("incident_documents_generated")
      .insert({ incident_id: incidentId, account_id: ctx.accountId, form, generated_by: ctx.userId })
      .select("id")
      .single();
    if (logError) {
      console.error("[POST /api/incidents/[id]/documents/[form]] log insert error:", logError);
    } else {
      generatedDocumentId = logged.id;
    }

    return NextResponse.json({ filename, base64: buffer.toString("base64"), generatedDocumentId });
  } catch (err) {
    return toErrorResponse(err);
  }
}
