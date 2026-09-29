import type {
  IncidentDetectionSource,
  IncidentSeverity,
  IncidentStatus,
  IncidentTypeCode,
} from "./constants";

export interface Incident {
  id: string;
  account_id: string;
  incident_number: number;
  title: string;
  description: string | null;
  incident_type: IncidentTypeCode;
  incident_type_secondary: string[];
  severity: IncidentSeverity;
  severity_downgrade_reason: string | null;
  status: IncidentStatus;
  detected_at: string;
  detection_source: IncidentDetectionSource;
  reporter_id: string | null;
  incident_lead_id: string | null;
  notifiable: boolean | null;
  notifiable_rationale: string | null;
  pdpa_relevant: boolean | null;
  aml_relevant: boolean | null;
  affected_systems: string | null;
  affected_identifiers: Record<string, unknown>;
  financial_impact_myr: number | null;
  customers_affected_count: number | null;
  merchants_affected_count: number | null;
  data_records_affected_count: number | null;
  downtime_minutes: number | null;
  contained_at: string | null;
  recovered_at: string | null;
  resumed_at: string | null;
  closed_at: string | null;
  root_cause: string | null;
  closed_by: string | null;
  pir_due_at: string | null;
  escalation_level: 1 | 2 | 3;
  escalation_level_entered_at: string;
  /** Migration 122 — precomputed, business-hours-aware timeout for the
   *  current escalation level; NULL once status leaves 'reported' or
   *  escalation_level reaches 3. Restamped by a DB trigger, never
   *  client-writable. */
  next_escalation_due_at: string | null;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // ---- Migration 123 — document-generation fields (Form A/B/C/D) ----
  incident_start_time: string | null;
  recipient_directly_affected: "yes" | "no" | "unknown" | null;
  containment_summary: string | null;
  eradication_summary: string | null;
  recovery_summary: string | null;
  vendor_involvement: string | null;
  attack_vector: string | null;
  threat_actor_info: string | null;
  children_data_involved: "yes" | "no" | "unknown" | null;
  contributing_factors: ("people" | "process" | "technology" | "third_party")[];
  contributing_factors_detail: string | null;
  pir_method: "5_whys" | "fishbone" | "other" | null;
  what_worked_well: string | null;
  what_did_not_work_well: string | null;
  funds_recovered_myr: number | null;
  funds_recovered_at: string | null;
  end_of_hypercare_at: string | null;
  pir_review_meeting_at: string | null;
  pir_review_attendees: string | null;
}

export interface IncidentActivity {
  id: string;
  incident_id: string;
  actor_id: string | null;
  event_type: "created" | "status_changed" | "severity_changed" | "type_changed" | "lead_changed" | "escalated" | "closed";
  from_value: string | null;
  to_value: string | null;
  created_at: string;
}

export interface IncidentComment {
  id: string;
  incident_id: string;
  author_id: string | null;
  body: string;
  mentions: string[];
  created_at: string;
  edited_at: string | null;
}

export interface IncidentAttachment {
  id: string;
  incident_id: string;
  comment_id: string | null;
  storage_path: string;
  url: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string | null;
  created_at: string;
  /** Migration 123 — SHA-256 hex digest, computed client-side at upload.
   *  Null for attachments uploaded before this field existed. */
  file_hash: string | null;
}

export interface IncidentWatcher {
  incident_id: string;
  user_id: string;
  created_at: string;
}

export interface IncidentAction {
  id: string;
  incident_id: string;
  description: string;
  owner_id: string | null;
  due_date: string | null;
  status: "open" | "done";
  closed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncidentNotificationSent {
  id: string;
  incident_id: string;
  recipient_party:
    | "bnm"
    | "sponsor_emi"
    | "partner"
    | "pdp_commissioner"
    | "data_subjects"
    | "police"
    | "other"
    | "safeguarding_bank"
    | "settlement_bank_acquirer"
    | "payment_network"
    | "nsrc"
    | "mycert";
  recipient_detail: string | null;
  method: string | null;
  reference: string | null;
  sent_at: string;
  recorded_by: string | null;
  created_at: string;
}

export interface IncidentEscalationEvent {
  id: string;
  incident_id: string;
  from_level: number;
  to_level: number;
  reason: "manual" | "auto_timeout";
  triggered_by: string | null;
  created_at: string;
}

/** Migration 122 — a per-account override of who gets notified at
 *  escalation level 2 or 3. When empty for a given level, the sweep
 *  falls back to admin/owner + incidents.manage capability holders. */
export interface IncidentEscalationRecipient {
  id: string;
  account_id: string;
  level: 2 | 3;
  user_id: string;
  added_by: string | null;
  added_at: string;
}

/** Migration 123 — one row per generated Form A/B/C/D, so Form C's
 *  "timeliness against targets" table can show when A/B were actually
 *  produced. `attachment_id` is set only when the generator also saved
 *  the document as incident evidence. */
export interface IncidentDocumentGenerated {
  id: string;
  incident_id: string;
  account_id: string;
  form: "a" | "b" | "c" | "d";
  generated_by: string | null;
  generated_at: string;
  attachment_id: string | null;
}

/** `INC-2026-42` — the display key, never stored redundantly (migration 116). */
export function incidentKey(incident: Pick<Incident, "created_at" | "incident_number">): string {
  return `INC-${new Date(incident.created_at).getFullYear()}-${incident.incident_number}`;
}
