// TypeScript interfaces for the incident standards registry
// (tables introduced in migration 196, extended by 206).
//
// A "template" owns the categories and the one severity scale an account
// raises incidents with. A "framework" is a pack of obligation rules
// (PDPA, ISO 27035, ISO 45001 ...) of which any number can be active.

export type IncidentStandardKind = "template" | "framework";

export interface IncidentStandard {
  id: string;
  slug: string;
  name: string;
  regulatory_body: string | null;
  sector: string | null;
  description: string | null;
  is_system: boolean;
  kind: IncidentStandardKind;
  created_at: string;
}

export interface IncidentTypeCatalogueEntry {
  id: string;
  standard_id: string;
  code: string;
  name: string;
  description: string | null;
  default_severity: string | null;
  /** When set, the raise-dialog warns if the chosen severity is weaker. */
  min_severity: string | null;
  notifiable: boolean;
  /** Flags a new incident of this type starts with (see INCIDENT_FLAGS). */
  default_flags: string[];
  position: number;
}

export interface IncidentSeverityLevel {
  id: string;
  standard_id: string;
  slug: string;
  label: string;
  /** Tailwind-compatible hex or CSS color for the severity badge. */
  color: string | null;
  /** Hours before auto-escalation to next level. */
  escalate_hrs: number | null;
  /** Hours before regulatory notification is required. */
  regulatory_hrs: number | null;
  /** Target resolution days. */
  resolve_days: number | null;
  position: number;
}

export interface AccountIncidentStandard {
  id: string;
  account_id: string;
  standard_id: string;
  is_active: boolean;
  activated_at: string;
}

/** One obligation a framework adds when an incident carries `trigger_flag`. */
export interface IncidentObligationRule {
  id: string;
  standard_id: string;
  code: string;
  title: string;
  description: string | null;
  trigger_flag: string;
  /** Hours after detection; null = no deadline. */
  due_hours: number | null;
  /** A recipient_party value when the obligation is "tell somebody". */
  party: string | null;
  position: number;
}

/** The full config loaded by useIncidentStandard. */
export interface IncidentStandardConfig {
  /** The account's active template. */
  standard: IncidentStandard;
  types: IncidentTypeCatalogueEntry[];
  severities: IncidentSeverityLevel[];
  /** Active frameworks and their rules. */
  frameworks: IncidentStandard[];
  rules: IncidentObligationRule[];
}

/** A template's categories and severity scale, looked up by standard id. */
export interface StandardCatalogue {
  standard: IncidentStandard;
  types: IncidentTypeCatalogueEntry[];
  severities: IncidentSeverityLevel[];
}
