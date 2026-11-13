// POST /api/incidents/[id]/ai-narrative
// Generates a formal narrative for the incident filing report. Unlike the
// inline summary, this targets the signed PDF: objective past-tense prose a
// school administrator would sign-off on. NOT saved here — the caller puts it
// in a textarea and the incident lead edits and passes it to filed-reports.
// Requires incidents.export (same gate as generating the report itself).
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { loadAiConfig } from "@/lib/ai/config";
import { generateReply } from "@/lib/ai/generate";
import { AiError } from "@/lib/ai/types";
import { kindOf } from "@/lib/incidents/platform/note-kinds";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireCapability("incidents.export");
    const { id } = await params;

    const [incRow, comRows] = await Promise.all([
      supabase.from("incidents").select("title, description, status, severity, root_cause, occurred_at, closed_at, incident_type").eq("id", id).eq("account_id", accountId).maybeSingle(),
      supabase.from("incident_comments").select("body, kind, is_finding, created_at").eq("incident_id", id).eq("account_id", accountId).order("created_at", { ascending: true }),
    ]);

    if (!incRow.data) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
    const incident = incRow.data as { title: string; description: string | null; status: string; severity: string | null; root_cause: string | null; occurred_at: string | null; closed_at: string | null; incident_type: string };
    if (incident.status !== "closed") return NextResponse.json({ error: "The incident is not closed yet. Close it before drafting the filing narrative." }, { status: 409 });
    const comments = (comRows.data ?? []) as Array<{ body: string; kind: string | null; is_finding: boolean | null; created_at: string }>;

    const config = await loadAiConfig(supabase, accountId, { task: "draft" }).catch((err) => {
      console.error("[ai-narrative] loadAiConfig error:", err);
      throw new AiError("Stored API key could not be decrypted.", { code: "key_decrypt_failed", status: 400 });
    });
    if (!config) {
      return NextResponse.json({ error: "AI assistant is not set up. Enable it in Settings → AI Assistant.", code: "ai_not_configured" }, { status: 400 });
    }

    const findings = comments.filter((c) => kindOf(c) === "finding").map((c) => `• ${c.body}`).join("\n");
    const investigations = comments.filter((c) => kindOf(c) === "investigation").map((c) => `• ${c.body}`).join("\n");
    const closing = comments.filter((c) => kindOf(c) === "closing").map((c) => `• ${c.body}`).join("\n");

    const userContent = [
      `Incident title: ${incident.title}`,
      incident.description ? `Description: ${incident.description}` : null,
      incident.incident_type ? `Category: ${incident.incident_type}` : null,
      incident.severity ? `Severity: ${incident.severity}` : null,
      incident.occurred_at ? `Date of incident: ${new Date(incident.occurred_at).toUTCString()}` : null,
      incident.closed_at ? `Date closed: ${new Date(incident.closed_at).toUTCString()}` : null,
      incident.root_cause ? `Root cause: ${incident.root_cause}` : null,
      investigations ? `Investigation notes:\n${investigations}` : null,
      findings ? `Findings:\n${findings}` : null,
      closing ? `Closing notes:\n${closing}` : null,
    ].filter(Boolean).join("\n\n");

    const systemPrompt = "You are a compliance officer writing the official narrative section of a closed incident report for filing and regulatory purposes. Write 3–4 formal paragraphs in the past tense. Cover: (1) what occurred and when, (2) the investigation conducted and key findings, (3) how the matter was resolved and what steps were completed, (4) any corrective actions or follow-up measures. Write in professional administrative English. Be objective and factual — use only the information provided. No bullet points, no headers — flowing formal prose only. The incident lead will review and edit this before signing.";

    const { text } = await generateReply({
      config,
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    return NextResponse.json({ narrative: text.trim() });
  } catch (err) {
    return toErrorResponse(err);
  }
}
