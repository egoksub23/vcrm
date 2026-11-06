// Return to Play. The nurse sets a "not before" date for a student on an incident; the coach portal reads it (GET /api/public/clearances) and shows a
// warning. Nothing in Halo blocks a student from anything: the date is information, never a gate.

export const CLEARANCE_TYPES = ["injury", "concussion", "illness", "other"] as const;
export type ClearanceType = (typeof CLEARANCE_TYPES)[number];

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ClearanceInput {
  incidentId: string;
  studentId: string;
  type: ClearanceType;
  notBefore: string;
  note: string | null;
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

export function parseClearance(body: unknown, now: Date): Parsed<ClearanceInput> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Send the details." };
  const b = body as Record<string, unknown>;
  if (typeof b.incident_id !== "string" || !b.incident_id) return { ok: false, error: "Choose the incident." };
  if (typeof b.student_id !== "string" || !b.student_id) return { ok: false, error: "Choose the student." };
  const type = b.type === undefined ? "injury" : b.type;
  if (!CLEARANCE_TYPES.includes(type as ClearanceType)) return { ok: false, error: "Choose injury, concussion, illness or other." };
  if (!isDate(b.not_before)) return { ok: false, error: "Choose the first day the student may play, like 2026-11-20." };
  const today = now.toISOString().slice(0, 10);
  const oneYear = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
  if (b.not_before < today) return { ok: false, error: "That date has already passed." };
  if (b.not_before > oneYear) return { ok: false, error: "That date is more than a year away. Check it." };
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 300) : null;
  return { ok: true, value: { incidentId: b.incident_id, studentId: b.student_id, type: type as ClearanceType, notBefore: b.not_before, note } };
}

/** Is the clearance still a warning today? (The day itself is the first day the student may play, so the warning ends the day before.) */
export function isActive(c: { not_before: string; cleared_at: string | null }, today: string): boolean {
  return c.cleared_at === null && c.not_before > today;
}

/** The day label the portal shows: "not before 20 Nov 2026". */
export function describeNotBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `not before ${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
