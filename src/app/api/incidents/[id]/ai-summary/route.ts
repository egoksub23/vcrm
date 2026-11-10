// POST /api/incidents/[id]/ai-summary
// Generates a plain-text incident summary using the account's configured AI
// provider. Requires incidents.manage. The summary is NOT saved here — the
// caller puts it in the textarea and the incident lead saves it themselves.
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { loadAiConfig } from "@/lib/ai/config";
import { generateReply } from "@/lib/ai/generate";
import { AiError } from "@/lib/ai/types";
import { kindOf } from "@/lib/incidents/platform/note-kinds";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireCapability("incidents.manage");
    const { id } = await params;

    const [incRow, comRows] = await Promise.all([
      supabase.from("incidents").select("title, description, status, severity, root_cause, occurred_at").eq("id", id).eq("account_id", accountId).maybeSingle(),
      supabase.from("incident_comments").select("body, kind, is_finding, created_at").eq("incident_id", id).eq("account_id", accountId).order("created_at", { ascending: true }),
    ]);

    if (!incRow.data) return NextResponse.json({ error: "Incident not found." }, { status: 404 });
    const incident = incRow.data as { title: string; description: string | null; status: string; severity: string | null; root_cause: string | null; occurred_at: string | null };
    const comments = (comRows.data ?? []) as Array<{ body: string; kind: string | null; is_finding: boolean | null; created_at: string }>;

    const config = await loadAiConfig(supabase, accountId, { task: "draft" }).catch((err) => {
      console.error("[ai-summary] loadAiConfig error:", err);
      throw new AiError("Stored API key could not be decrypted.", { code: "key_decrypt_failed", status: 400 });
    });
    if (!config) {
      return NextResponse.json({ error: "AI assistant is not set up. Enable it in Settings → AI Assistant.", code: "ai_not_configured" }, { status: 400 });
    }

    const findings = comments.filter((c) => kindOf(c) === "finding").map((c) => `• ${c.body}`).join("\n");
    const investigations = comments.filter((c) => kindOf(c) === "investigation").map((c) => `• ${c.body}`).join("\n");
    const closing = comments.filter((c) => kindOf(c) === "closing").map((c) => `• ${c.body}`).join("\n");
    const general = comments.filter((c) => kindOf(c) === null).map((c) => `• ${c.body}`).join("\n");

    const userContent = [
      `Incident: ${incident.title}`,
      incident.description ? `Description: ${incident.description}` : null,
      incident.severity ? `Severity: ${incident.severity}` : null,
      incident.occurred_at ? `Occurred: ${new Date(incident.occurred_at).toUTCString()}` : null,
      incident.root_cause ? `Root cause on record: ${incident.root_cause}` : null,
      investigations ? `Investigation notes:\n${investigations}` : null,
      findings ? `Findings:\n${findings}` : null,
      closing ? `Conclusion notes:\n${closing}` : null,
      general ? `General notes:\n${general}` : null,
    ].filter(Boolean).join("\n\n");

    const systemPrompt = "You are an incident analyst. Write a concise, factual incident summary in plain English (3–5 short paragraphs). Cover: what happened and when, who was involved, the key findings from the investigation, what was done to resolve it, and what happens next. Use only the facts provided. Do not add speculation or recommendations beyond what the notes state. No headers, no bullet points — flowing prose only.";

    const { text } = await generateReply({
      config,
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    return NextResponse.json({ summary: text.trim() });
  } catch (err) {
    return toErrorResponse(err);
  }
}
