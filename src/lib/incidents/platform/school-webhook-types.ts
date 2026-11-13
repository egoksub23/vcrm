// Types and constants for school webhooks. Kept apart from school-webhooks.ts, which reaches the database,
// so the Setup screen (a client component) can import them without pulling the database driver into the browser bundle.

export const SCHOOL_WEBHOOK_EVENTS = ["incident.filed", "incident.closed", "incident.escalated", "incident.status_changed"] as const;
export type SchoolWebhookEvent = (typeof SCHOOL_WEBHOOK_EVENTS)[number];

export interface SchoolWebhookRow {
  id: string;
  account_id: string;
  url: string;
  events: SchoolWebhookEvent[];
  label: string | null;
  enabled: boolean;
  created_at: string;
  last_called_at: string | null;
  last_status_code: number | null;
}

export interface SchoolWebhookView extends SchoolWebhookRow {
  url_host: string;
}
