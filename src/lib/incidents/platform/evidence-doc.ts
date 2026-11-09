// Everything held about one incident, assembled in one place: the record page, the JSON download and the filed report (PDF) all read this, so they can never
// disagree. Read as the signed-in person first (another school's incident, or one they cannot see, is simply not found), then the service connection adds the
// names of staff and the coach's form answers.

import { answerLines, type AnswerLine } from "@/lib/incidents/intake/answers-view";
import { CCA_FORM, type FormSchema } from "@/lib/incidents/intake/form-schema";
import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import { textDates } from "./dates";
import { loadNamesForStandards } from "./records-data";
import { referenceOf } from "./registers";
import { loadApprovals } from "./workflow-data";

export interface EvidenceDoc {
  reference: string;
  generated_at: string;
  incident: Record<string, unknown> & {
    title: string;
    description: string | null;
    category_name: string;
    severity_label: string;
    status: string;
    created_at: string;
    closed_at: string | null;
    root_cause: string | null;
    incident_flags: string[] | null;
    activity?: { name?: string; venue?: string; date?: string; time?: string } | null;
    reporter_name?: string | null;
    reporter_email?: string | null;
    source?: string | null;
    is_test?: boolean;
  };
  people_named: { name: string; class_name: string | null; external_student_id: string | null; involvement: string; guardians: unknown[] | null }[];
  timeline: { event_type: string; from_value: string | null; to_value: string | null; created_at: string; actor: string | null }[];
  comments: { body: string; created_at: string; author: string | null }[];
  required_steps: { title: string; description: string | null; role_key: string | null; party: string | null; due_at: string | null; status: string; completed_at: string | null }[];
  approvals: { role_key: string; decision: string | null; requested_at: string; decided_at: string | null; note: string | null }[];
  message_log: { role_key: string; recipient_name: string; channel: string; address: string; reason: string; status: string; sent_at: string | null; acknowledged_at: string | null; is_test?: boolean | null }[];
  files: { filename: string; mime_type: string; size_bytes: number; file_hash: string | null; created_at: string }[];
  /** The names behind the codes on this incident, from the template it was raised under. */
  names: { categories: { code: string; name: string }[]; severities: { slug: string; label: string }[] };
  /** What the coach answered on the report form, for a report that came from the coach portal; otherwise null. */
  report_answers: AnswerLine[] | null;
  return_to_play: { student_name: string; type: string; not_before: string; note: string | null; cleared_at: string | null }[] | null;
}

/** The coach form's questions and the coach's answers, labelled with the wording of the form version the report was filed under. */
export async function loadAnswerLines(admin: PgDb, accountId: string, inc: { source?: string | null; form_version?: number | null; custom_fields?: Record<string, unknown> | null }): Promise<AnswerLine[] | null> {
  const fromHalo = !inc.source || inc.source === "halo";
  if (fromHalo && Object.keys(inc.custom_fields ?? {}).length === 0) return null;
  let schema: FormSchema = CCA_FORM;
  if (inc.form_version != null) {
    const { data: v } = await admin.from("incident_form_versions").select("schema").eq("account_id", accountId).eq("form_key", "cca").eq("version", inc.form_version).maybeSingle();
    if (v) schema = (v as { schema: FormSchema }).schema;
  }
  return answerLines(schema, inc.custom_fields ?? {});
}

/** The incident record, or null when this person cannot see it (or it belongs to another school). */
export async function loadEvidenceDoc(args: { db: PgDb; accountId: string; incidentId: string; canMedical: boolean; admin?: PgDb; now?: Date }): Promise<EvidenceDoc | null> {
  const { db, accountId, incidentId, canMedical } = args;
  const admin = args.admin ?? createAdminPgDb();
  const { data: incident } = await db.from("incidents").select("*").eq("id", incidentId).eq("account_id", accountId).maybeSingle();
  if (!incident) return null;
  const inc = textDates(incident as Record<string, unknown> & { created_at: string; closed_at: string | null; incident_number: number }, ["created_at", "closed_at"]);

  const [names, involved, comments, activity, steps, deliveries, files, approvals] = await Promise.all([
    loadNamesForStandards(db, accountId, [inc.standard_id as string | null]),
    db.from("incident_involved").select("name, class_name, external_student_id, involvement, guardians").eq("incident_id", incidentId),
    db.from("incident_comments").select("author_id, body, created_at").eq("incident_id", incidentId).order("created_at"),
    db.from("incident_activity").select("actor_id, event_type, from_value, to_value, created_at").eq("incident_id", incidentId).order("created_at"),
    db.from("incident_obligations").select("title, description, party, role_key, due_at, status, completed_at").eq("incident_id", incidentId).order("due_at"),
    db.from("incident_deliveries").select("role_key, recipient_name, channel, address, reason, status, sent_at, acknowledged_at, is_test").eq("incident_id", incidentId).order("created_at"),
    db.from("incident_attachments").select("filename, mime_type, size_bytes, file_hash, created_at").eq("incident_id", incidentId).order("created_at"),
    loadApprovals(db, incidentId, accountId),
  ]);

  // Staff names: who reported it, who wrote each note, who made each move.
  const commentRows = (comments.data ?? []) as { author_id: string | null; body: string; created_at: string }[];
  const activityRows = (activity.data ?? []) as { actor_id: string | null; event_type: string; from_value: string | null; to_value: string | null; created_at: string }[];
  const ids = [...new Set([inc.reporter_id as string | null, ...commentRows.map((c) => c.author_id), ...activityRows.map((a) => a.actor_id)].filter((x): x is string => !!x))];
  const nameOf = new Map<string, string>();
  if (ids.length > 0) {
    const { data: profiles } = await admin.from("profiles").select("user_id, full_name, email").in("user_id", ids).eq("account_id", accountId);
    for (const p of (profiles ?? []) as { user_id: string; full_name: string | null; email: string | null }[]) nameOf.set(p.user_id, p.full_name?.trim() || p.email || "");
  }
  const who = (id: string | null) => (id ? nameOf.get(id) || null : null);

  const clearances = canMedical
    ? ((await admin.from("person_clearances").select("student_name, type, not_before, note, cleared_at").eq("account_id", accountId).eq("incident_id", incidentId)).data ?? []).map((c: Record<string, unknown>) => textDates(c, ["cleared_at"], ["not_before"]))
    : null;

  const cat = names.categories.find((c) => c.code === inc.incident_type)?.name ?? (inc.incident_type as string);
  const sev = names.severities.find((s) => s.slug === inc.severity)?.label ?? (inc.severity as string);
  const reporterName = (inc.reporter_name as string | null) || who(inc.reporter_id as string | null);

  return {
    reference: referenceOf(inc),
    generated_at: (args.now ?? new Date()).toISOString(),
    names: { categories: names.categories, severities: names.severities },
    incident: { ...inc, category_name: cat, severity_label: sev, reporter_name: reporterName } as unknown as EvidenceDoc["incident"],
    people_named: (involved.data ?? []) as EvidenceDoc["people_named"],
    timeline: activityRows.map((a) => textDates({ ...a, actor: who(a.actor_id) }, ["created_at"])).map(({ actor_id: _a, ...rest }) => rest) as EvidenceDoc["timeline"],
    comments: commentRows.map((c) => textDates({ ...c, author: who(c.author_id) }, ["created_at"])).map(({ author_id: _a, ...rest }) => rest) as EvidenceDoc["comments"],
    required_steps: ((steps.data ?? []) as Record<string, unknown>[]).map((s) => textDates(s, ["due_at", "completed_at"])) as EvidenceDoc["required_steps"],
    approvals: ((approvals ?? []) as unknown as Record<string, unknown>[]).map((a) => textDates(a, ["requested_at", "decided_at"])) as EvidenceDoc["approvals"],
    message_log: ((deliveries.data ?? []) as Record<string, unknown>[]).filter((d) => !d.is_test).map((d) => textDates(d, ["sent_at", "acknowledged_at"])) as EvidenceDoc["message_log"],
    files: ((files.data ?? []) as Record<string, unknown>[]).map((f) => textDates(f, ["created_at"])) as EvidenceDoc["files"],
    report_answers: await loadAnswerLines(admin, accountId, inc as { source?: string | null; form_version?: number | null; custom_fields?: Record<string, unknown> | null }),
    return_to_play: clearances as EvidenceDoc["return_to_play"],
  };
}
