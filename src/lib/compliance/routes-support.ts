// Small helpers for the /api/compliance routes (kept apart from http.ts so the lists stay out of the HTTP edge).
import { REQUEST_STATUSES, type RequestStatus } from "./types";

/** The work capabilities: holding one of them (besides menu.compliance) lets a person read the list and a case. menu.compliance alone opens no data route. */
export const READ_CAPABILITIES = ["compliance.review", "compliance.approve", "compliance.execute", "compliance.reveal"] as const;

/** A status name from a request body, or null. */
export const oneStatus = (v: unknown): RequestStatus | null => (typeof v === "string" && (REQUEST_STATUSES as readonly string[]).includes(v) ? (v as RequestStatus) : null);
