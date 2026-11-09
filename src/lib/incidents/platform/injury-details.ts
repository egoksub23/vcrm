// The injury details a member of staff can add when they raise an incident of an injury kind (a CCA or sports injury): who was hurt, the activity and where,
// when, where on the body, and whether the head was hit. The same questions the coach report form asks, kept in the same places (the people in
// incident_involved, the activity on the incident, the answers in custom_fields under the form's own keys), so an incident reads the same however it was
// raised and the filed report shows it the same way. Pure: raw input in, checked values out.

export const BODY_PARTS = ["head", "arm", "leg", "back", "other"] as const;
export type BodyPart = (typeof BODY_PARTS)[number];

export interface InjuryDetails {
  people: { name: string; class_name: string | null }[];
  activity: { name?: string; venue?: string; date?: string; time?: string } | null;
  customFields: { body_part?: BodyPart; head_injury?: boolean };
  /** The head was hit or the student seemed dazed: the incident also carries the concussion flag, so the nurse is told. */
  concussion: boolean;
}

export const MAX_PEOPLE = 10;
const MAX_TEXT = 120;

const text = (v: unknown, max = MAX_TEXT): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

function isDay(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

export function parseInjuryDetails(raw: unknown): { ok: true; value: InjuryDetails | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "'details' must be an object" };
  const d = raw as Record<string, unknown>;

  const people: InjuryDetails["people"] = [];
  if (d.people !== undefined) {
    if (!Array.isArray(d.people)) return { ok: false, error: "'details.people' must be a list" };
    for (const p of d.people) {
      const name = text((p as { name?: unknown } | null)?.name);
      if (!name) continue; // an empty row is simply left out
      people.push({ name, class_name: text((p as { class_name?: unknown }).class_name, 40) });
    }
    if (people.length > MAX_PEOPLE) return { ok: false, error: `Name at most ${MAX_PEOPLE} people.` };
  }

  const date = text(d.date, 10);
  if (date && !isDay(date)) return { ok: false, error: "The date must look like 2026-11-05." };
  const time = text(d.time, 5);
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, error: "The time must look like 14:30." };
  const name = text(d.activity);
  const venue = text(d.venue);
  const activity: InjuryDetails["activity"] = name || venue || date || time ? { ...(name ? { name } : {}), ...(venue ? { venue } : {}), ...(date ? { date } : {}), ...(time ? { time } : {}) } : null;

  const customFields: InjuryDetails["customFields"] = {};
  if (d.bodyPart !== undefined && d.bodyPart !== null && d.bodyPart !== "") {
    if (typeof d.bodyPart !== "string" || !(BODY_PARTS as readonly string[]).includes(d.bodyPart)) return { ok: false, error: "'details.bodyPart' is not recognised" };
    customFields.body_part = d.bodyPart as BodyPart;
  }
  if (d.headInjury !== undefined && d.headInjury !== null) {
    if (typeof d.headInjury !== "boolean") return { ok: false, error: "'details.headInjury' must be true or false" };
    customFields.head_injury = d.headInjury;
  }

  return { ok: true, value: { people, activity, customFields, concussion: customFields.head_injury === true } };
}
