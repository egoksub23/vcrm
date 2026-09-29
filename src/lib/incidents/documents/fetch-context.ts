import type { SupabaseClient } from "@supabase/supabase-js";

import { ESCALATION_DEFAULT_MINUTES } from "../constants";
import type { Incident, IncidentAction, IncidentAttachment, IncidentEscalationEvent, IncidentNotificationSent } from "../types";
import type { IncidentDocumentContext } from "./types";

/** Assembles everything a document builder needs from one incident
 *  record, in parallel. Returns null if the incident doesn't exist (the
 *  route's own RLS-scoped `supabase` client already limits this to
 *  incidents the caller can see). */
export async function fetchIncidentDocumentContext(
  supabase: SupabaseClient,
  incidentId: string,
  accountId: string,
): Promise<IncidentDocumentContext | null> {
  const { data: incident, error } = await supabase.from("incidents").select("*").eq("id", incidentId).maybeSingle();
  if (error || !incident) return null;
  const row = incident as Incident;

  const [
    { data: actions },
    { data: notificationsSent },
    { data: attachmentRows },
    { data: evidenceRows },
    { data: escalationEvents },
    { data: account },
    { data: policy },
    { data: docsGenerated },
  ] = await Promise.all([
    supabase.from("incident_actions").select("*").eq("incident_id", incidentId).order("created_at", { ascending: true }),
    supabase.from("incident_notifications_sent").select("*").eq("incident_id", incidentId).order("sent_at", { ascending: true }),
    supabase.from("incident_attachments").select("*").eq("incident_id", incidentId).order("created_at", { ascending: true }),
    supabase.from("incident_evidence_log").select("attachment_id, description").eq("incident_id", incidentId),
    supabase.from("incident_escalation_events").select("*").eq("incident_id", incidentId).order("created_at", { ascending: true }),
    supabase
      .from("accounts")
      .select("incident_contact_name, incident_contact_role, incident_contact_mobile, incident_contact_email")
      .eq("id", accountId)
      .maybeSingle(),
    supabase
      .from("incident_escalation_policies")
      .select("level_1_minutes, level_2_minutes")
      .eq("account_id", accountId)
      .eq("severity", row.severity)
      .maybeSingle(),
    supabase
      .from("incident_documents_generated")
      .select("form, generated_at")
      .eq("incident_id", incidentId)
      .in("form", ["a", "b"])
      .order("generated_at", { ascending: false }),
  ]);

  const evidenceByAttachment = new Map<string, string>();
  for (const e of evidenceRows ?? []) {
    if (e.attachment_id) evidenceByAttachment.set(e.attachment_id, e.description);
  }

  const personIds = [row.reporter_id, row.incident_lead_id].filter((v): v is string => !!v);
  const { data: profileRows } = personIds.length
    ? await supabase.from("profiles").select("user_id, full_name").in("user_id", personIds)
    : { data: [] };
  const nameByUser = new Map<string, string>();
  for (const p of profileRows ?? []) nameByUser.set(p.user_id, p.full_name ?? "");

  const defaults = ESCALATION_DEFAULT_MINUTES[row.severity];
  const lastA = (docsGenerated ?? []).find((d) => d.form === "a")?.generated_at ?? null;
  const lastB = (docsGenerated ?? []).find((d) => d.form === "b")?.generated_at ?? null;

  return {
    incident: row,
    actions: (actions ?? []) as IncidentAction[],
    notificationsSent: (notificationsSent ?? []) as IncidentNotificationSent[],
    attachments: ((attachmentRows ?? []) as IncidentAttachment[]).map((a) => ({
      ...a,
      evidenceDescription: evidenceByAttachment.get(a.id) ?? null,
    })),
    escalationEvents: (escalationEvents ?? []) as IncidentEscalationEvent[],
    reporterName: row.reporter_id ? (nameByUser.get(row.reporter_id) ?? "") : "",
    incidentLeadName: row.incident_lead_id ? (nameByUser.get(row.incident_lead_id) ?? null) : null,
    accountContact: {
      name: account?.incident_contact_name ?? null,
      role: account?.incident_contact_role ?? null,
      mobile: account?.incident_contact_mobile ?? null,
      email: account?.incident_contact_email ?? null,
    },
    escalationTargetMinutes: {
      level1: policy?.level_1_minutes ?? defaults.level1,
      level2: policy?.level_2_minutes ?? defaults.level2,
    },
    lastGenerated: { a: lastA, b: lastB },
  };
}
