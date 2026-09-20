// ============================================================
// Ticket SLA types (migration 086). Pure, shared by the API routes, the
// settings screens, the ticket surfaces and the tests.
// ============================================================

import type { ChannelType, TicketCategory, TicketPriority } from "@/types";
import type { WeeklyHours } from "./business-time";

/** One target (first response or resolution) of one ticket. */
export const SLA_TARGET_STATES = ["none", "running", "paused", "met", "breached"] as const;
export type SlaTargetState = (typeof SLA_TARGET_STATES)[number];

export type SlaTarget = "first_response" | "resolution";

/** The states a ticket filter / group can name. */
export type SlaOverallState = "none" | "on_track" | "at_risk" | "breached" | "paused" | "met";

/** Channels a policy can name (the linked conversation's last_channel_type). */
export const SLA_CHANNELS: readonly ChannelType[] = [
  "whatsapp",
  "web_widget",
  "messenger",
  "instagram",
  "email",
  "gmail",
];

export interface PolicyConditions {
  priorities?: TicketPriority[];
  categories?: TicketCategory[];
  /** The ticket has ANY of these labels. */
  labels?: string[];
  channels?: string[];
  team_ids?: string[];
}

export interface SlaPolicy {
  id: string;
  account_id: string;
  name: string;
  /** Evaluated in ascending order; the first active match wins. */
  position: number;
  is_active: boolean;
  conditions: PolicyConditions;
  first_response_minutes: number | null;
  resolution_minutes: number | null;
  /** null = 24/7. */
  schedule_id: string | null;
  pause_while_pending: boolean;
  at_risk_percent: number;
  created_at?: string;
  updated_at?: string;
}

export interface SlaHoliday {
  id: string;
  schedule_id: string;
  /** "YYYY-MM-DD" in the schedule's own zone. */
  holiday_date: string;
  name: string;
}

export interface SlaSchedule {
  id: string;
  account_id: string;
  name: string;
  timezone: string;
  is_default: boolean;
  weekly: WeeklyHours;
  holidays: SlaHoliday[];
  created_at?: string;
  updated_at?: string;
}

/** The SLA columns of a ticket row (migration 086). All optional so older rows type-check. */
export interface TicketSlaFields {
  sla_policy_id?: string | null;
  sla_first_response_due_at?: string | null;
  sla_first_response_risk_at?: string | null;
  sla_first_response_at?: string | null;
  sla_first_response_state?: SlaTargetState;
  sla_resolution_due_at?: string | null;
  sla_resolution_risk_at?: string | null;
  sla_resolution_state?: SlaTargetState;
  sla_paused_at?: string | null;
  sla_stopped_at?: string | null;
  sla_evaluated_at?: string | null;
}

export const SLA_LIMITS = {
  /** Minutes: one year. */
  maxTargetMinutes: 525_600,
  maxPolicies: 50,
  maxSlotsPerDay: 4,
  atRiskMin: 50,
  atRiskMax: 95,
  atRiskDefault: 80,
  maxNameLength: 80,
  maxHolidayNameLength: 80,
  maxListEntries: 50,
} as const;

/** Codes an API route returns; the screens translate them (`Settings.sla.errors.*`). */
export const SLA_ERROR_CODES = [
  "invalid_timezone",
  "invalid_weekly",
  "overlap",
  "too_many_slots",
  "bad_time",
  "end_before_start",
  "no_open_day",
  "invalid_name",
  "invalid_targets",
  "targets_order",
  "invalid_conditions",
  "invalid_percent",
  "schedule_in_use",
  "schedule_missing",
  "default_required",
  "duplicate_holiday",
  "invalid_date",
  "policy_limit",
  "not_found",
  "forbidden",
  "failed",
] as const;
export type SlaErrorCode = (typeof SLA_ERROR_CODES)[number];
