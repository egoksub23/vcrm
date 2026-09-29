import type {
  Incident,
  IncidentAction,
  IncidentAttachment,
  IncidentEscalationEvent,
  IncidentNotificationSent,
} from "../types";

/** Everything a document builder can pull straight from the record —
 *  assembled server-side by fetch-context.ts. Compose-time-only fields
 *  (narrative that's fresh per send) are NOT here; they come in via
 *  each form's own ComposeInput. */
export interface IncidentDocumentContext {
  incident: Incident;
  actions: IncidentAction[];
  notificationsSent: IncidentNotificationSent[];
  attachments: (IncidentAttachment & { evidenceDescription: string | null })[];
  escalationEvents: IncidentEscalationEvent[];
  reporterName: string;
  incidentLeadName: string | null;
  accountContact: {
    name: string | null;
    role: string | null;
    mobile: string | null;
    email: string | null;
  };
  /** Form C §4a "Required" column source — the account's configured
   *  timer for this incident's severity (or the built-in default). */
  escalationTargetMinutes: { level1: number; level2: number };
  /** When Form A / Form B were last generated for this incident, if
   *  ever — Form C §4a's "Actual" column for those two rows. */
  lastGenerated: { a: string | null; b: string | null };
}

export interface FormAComposeInput {
  preparedByName: string;
  preparedByRole: string;
  approvedByName?: string;
  approvedByRole?: string;
  recipients: ("bnm" | "sponsor_emi" | "safeguarding_bank" | "settlement_bank_acquirer" | "payment_network" | "other")[];
  actionsRequested?: string;
  otherPartiesNotified: ("sponsor_emi" | "pdp_commissioner" | "nsrc" | "mycert" | "none_yet")[];
  nextUpdateDue?: string;
}

export interface FormBComposeInput {
  preparedByName: string;
  preparedByRole: string;
  approvedByName?: string;
  approvedByRole?: string;
  formASentAt?: string;
  executiveSummary: string;
  timeline: { at: string; event: string; by: string }[];
  reputationalRegulatoryImpact?: string;
  nextStepsContact: { name: string; role: string };
}

export interface TimelinessRow {
  label: string;
  required?: string;
  actual?: string;
  met?: boolean;
  reasonIfMissed?: string;
}

export interface FormCComposeInput {
  preparedByName: string;
  preparedByRole: string;
  reviewMeetingAttendees?: string;
  /** Pre-filled from the record where possible (see fetch-context.ts's
   *  escalationTargetMinutes/lastGenerated/escalationEvents) — the user
   *  edits or fills in the rest, since not every row can be automated
   *  (see the plan's Form C §4a discussion). */
  timelinessRows: TimelinessRow[];
  signOffIncidentLeadName?: string;
  signOffCeoName?: string;
}

export interface FormDComposeInput {
  preparedByName: string;
  preparedByRole: string;
  approvedByName?: string;
  approvedByRole?: string;
  updateType: "status_update" | "final_closure";
  updateNumber?: number;
  changesSinceLastUpdate: string;
  completedSinceLastUpdate?: string;
  inProgressNextSteps?: string;
  requestsToRecipient?: string;
  nextUpdateDue?: string;
}

export type FormLetter = "a" | "b" | "c" | "d";
