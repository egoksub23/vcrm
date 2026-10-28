// TypeScript interfaces for the incident standards registry
// (tables introduced in migration 196).

export interface IncidentStandard {
  id: string;
  slug: string;
  name: string;
  regulatory_body: string | null;
  sector: string | null;
  description: string | null;
  is_system: boolean;
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

/** The full config loaded by useIncidentStandard. */
export interface IncidentStandardConfig {
  standard: IncidentStandard;
  types: IncidentTypeCatalogueEntry[];
  severities: IncidentSeverityLevel[];
}
