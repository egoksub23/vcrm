// ============================================================
// Incident Reporting constants — taxonomy straight from Vircle's
// Security Incident Reporting and Management Policy (VCL-ISP-IRP-001
// v1.0), Section 8 (incident types) and Section 9 (severity). Migration
// 116 mirrors this exact set in the `incidents` table's CHECK
// constraints; keep the two in lockstep.
// ============================================================

export type IncidentSeverity = "P1" | "P2" | "P3" | "P4";
export type IncidentStatus =
  | "reported"
  | "triaged"
  | "contained"
  | "investigating"
  | "recovered"
  | "closed";
export type IncidentTypeCode =
  | "SB"
  | "DB"
  | "FL"
  | "LI"
  | "TF"
  | "QF"
  | "AT"
  | "IF"
  | "UA"
  | "MW"
  | "AV"
  | "TP"
  | "SA"
  | "DF";
export type IncidentDetectionSource =
  | "monitoring_alert"
  | "staff"
  | "customer"
  | "merchant"
  | "regulator_partner"
  | "reconciliation"
  | "vendor"
  | "other";

/** Board/lifecycle order — the policy's 8-stage process (§10) collapsed
 *  onto 6 record statuses; "resume" is captured as `resumed_at` rather
 *  than its own column, since it always sits between recovered and closed. */
export const INCIDENT_STATUSES: IncidentStatus[] = [
  "reported",
  "triaged",
  "contained",
  "investigating",
  "recovered",
  "closed",
];

/** Most critical first. */
export const INCIDENT_SEVERITIES: IncidentSeverity[] = ["P1", "P2", "P3", "P4"];

export const INCIDENT_SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  P1: "Critical",
  P2: "High",
  P3: "Medium",
  P4: "Low",
};

export interface IncidentTypeDef {
  code: IncidentTypeCode;
  label: string;
  description: string;
}

/** Section 8's thirteen-row table (fourteen codes — DF was added after
 *  the table's original count note). Order matches the policy. */
export const INCIDENT_TYPES: IncidentTypeDef[] = [
  { code: "SB", label: "Security breach / unauthorised access", description: "Unauthorised access to systems, accounts or data" },
  { code: "DB", label: "Data breach / data leakage", description: "Loss, disclosure or misuse of personal or confidential data" },
  { code: "FL", label: "Float / safeguarding incident", description: "E-money liabilities not fully matched by safeguarded funds, or safeguarded funds at risk" },
  { code: "LI", label: "Ledger integrity / processing error", description: "Incorrect, lost, duplicated or corrupted balances or transactions" },
  { code: "TF", label: "Top-up, transfer and payment fraud", description: "Fraudulent funding, transfers, payments or refunds" },
  { code: "QF", label: "QR payment fraud and tampering", description: "Manipulation of QR codes or payment flows" },
  { code: "AT", label: "Account takeover / credential compromise", description: "Takeover of customer, merchant, staff or API credentials" },
  { code: "IF", label: "Internal fraud / employee misconduct", description: "Dishonest or unauthorised acts by staff or contractors" },
  { code: "UA", label: "Unacceptable use / policy violation", description: "Staff activity against policy without confirmed fraud" },
  { code: "MW", label: "Malware and ransomware", description: "Malicious code on Vircle systems or staff devices" },
  { code: "AV", label: "Availability / denial of service", description: "Loss or degradation of e-money services with a security or integrity dimension" },
  { code: "TP", label: "Third-party / supply-chain incident", description: "Incident at a provider or partner that affects Vircle" },
  { code: "SA", label: "Suspicious activity / other", description: "Anomalous behaviour needing investigation that does not fit another type" },
  { code: "DF", label: "DuitNow linked fraud and layering", description: "Suspicious movement between principal and unverified supplementary user coupled with outflow within 24 hours or shorter" },
];

export function incidentTypeLabel(code: string): string {
  return INCIDENT_TYPES.find((t) => t.code === code)?.label ?? code;
}

export const INCIDENT_DETECTION_SOURCES: { value: IncidentDetectionSource; label: string }[] = [
  { value: "customer", label: "Customer report" },
  { value: "staff", label: "Staff member" },
  { value: "monitoring_alert", label: "Monitoring alert" },
  { value: "reconciliation", label: "Reconciliation break" },
  { value: "merchant", label: "Merchant report" },
  { value: "regulator_partner", label: "Regulator or partner" },
  { value: "vendor", label: "Vendor advisory" },
  { value: "other", label: "Other" },
];

/**
 * §9.1's "mandatory minimum severities" box: these categories of report
 * default to at least P2 — the UI suggests, never silently forces, per
 * the plan (a downgrade below the minimum stays possible with a logged
 * reason). Matched heuristically off the incident type at raise time;
 * final classification is always a Compliance Officer's call at triage.
 */
export const P2_MINIMUM_TYPES: readonly IncidentTypeCode[] = ["DB", "FL", "AT", "TP"];

export function suggestsP2Minimum(type: IncidentTypeCode, detectionSource: IncidentDetectionSource): boolean {
  return P2_MINIMUM_TYPES.includes(type) || detectionSource === "regulator_partner";
}

/** Incidents fetched per page of the list view (mirrors Tickets' LIST_PAGE_SIZE). */
export const LIST_PAGE_SIZE = 200;
/** Incidents fetched per board column. */
export const BOARD_COLUMN_PAGE_SIZE = 100;
