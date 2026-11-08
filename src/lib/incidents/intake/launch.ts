// What the coach portal sends to start a report, and how it is checked. Pure: the route calls this and maps the message to a 400.
// The roster holds children's names, so it is size-limited and never echoed back in an error.

import { isPlausibleEmail } from "@/lib/incidents/platform/roles";
import { urlOnAllowedOrigin } from "./keys";
import type { RosterEntry } from "./form-schema";

export interface LaunchInput {
  form: string;
  /** The coach who is reporting. The name and the email are required: the report, and any reply, is addressed to this person. */
  coach: { id: string; name: string; email: string; phone: string | null };
  activity: { id: string; name: string; venue: string | null; date: string | null };
  roster: RosterEntry[];
  returnUrl: string | null;
}

export type LaunchParse = { ok: true; value: LaunchInput } | { ok: false; error: string; field?: string };

const MAX_ROSTER = 200;
const MAX_GUARDIANS = 4;

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}
function optStr(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  return str(v, max) ?? undefined; // undefined = present but invalid
}

const bad = (error: string, field?: string): LaunchParse => ({ ok: false, error, field });

export function parseLaunch(body: unknown, allowedOrigins: readonly string[], knownForms: readonly string[] = ["cca"]): LaunchParse {
  if (!obj(body)) return bad("Send a JSON object.");

  const form = body.form === undefined ? "cca" : str(body.form, 40);
  if (!form || !knownForms.includes(form)) return bad(`"form" must be one of: ${knownForms.join(", ")}.`, "form");

  if (!obj(body.coach)) return bad("\"coach\" is required.", "coach");
  const coachId = str(body.coach.id, 100);
  const coachName = str(body.coach.name, 120);
  if (!coachId || !coachName) return bad("\"coach.id\" and \"coach.name\" are required.", "coach");
  const coachEmail = str(body.coach.email, 200);
  if (!coachEmail) return bad("\"coach.email\" is required.", "coach.email");
  if (!isPlausibleEmail(coachEmail)) return bad("\"coach.email\" is not a valid email address.", "coach.email");
  const coachPhone = optStr(body.coach.phone, 30);
  if (coachPhone === undefined) return bad("\"coach.phone\" is not valid.", "coach.phone");

  if (!obj(body.activity)) return bad("\"activity\" is required.", "activity");
  const actId = str(body.activity.id, 100);
  const actName = str(body.activity.name, 160);
  if (!actId || !actName) return bad("\"activity.id\" and \"activity.name\" are required.", "activity");
  const venue = optStr(body.activity.venue, 160);
  if (venue === undefined) return bad("\"activity.venue\" is too long.", "activity.venue");
  const date = optStr(body.activity.date, 10);
  if (date === undefined || (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))))) return bad("\"activity.date\" must look like 2026-11-11.", "activity.date");

  if (!Array.isArray(body.roster)) return bad("\"roster\" must be a list (it can be empty).", "roster");
  if (body.roster.length > MAX_ROSTER) return bad(`The roster has more than ${MAX_ROSTER} people.`, "roster");
  const roster: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const [i, r] of body.roster.entries()) {
    if (!obj(r)) return bad(`roster[${i}] must be an object.`, "roster");
    const id = str(r.student_id, 100);
    const name = str(r.name, 120);
    if (!id || !name) return bad(`roster[${i}] needs "student_id" and "name".`, "roster");
    if (seen.has(id)) return bad(`roster has "student_id" ${id} twice.`, "roster");
    seen.add(id);
    const cls = optStr(r.class, 60);
    if (cls === undefined) return bad(`roster[${i}].class is too long.`, "roster");
    const guardians: NonNullable<RosterEntry["guardians"]> = [];
    if (r.guardians !== undefined) {
      if (!Array.isArray(r.guardians) || r.guardians.length > MAX_GUARDIANS) return bad(`roster[${i}].guardians must be a list of at most ${MAX_GUARDIANS}.`, "roster");
      for (const g of r.guardians) {
        if (!obj(g)) return bad(`roster[${i}].guardians must hold objects.`, "roster");
        const gName = optStr(g.name, 120);
        const gEmail = optStr(g.email, 200);
        const gPhone = optStr(g.phone, 30);
        if (gName === undefined || gEmail === undefined || gPhone === undefined || (gEmail && !isPlausibleEmail(gEmail))) return bad(`roster[${i}] has a guardian with invalid details.`, "roster");
        if (gEmail || gPhone) guardians.push({ name: gName ?? undefined, email: gEmail ?? undefined, phone: gPhone ?? undefined });
      }
    }
    roster.push({ student_id: id, name, class: cls ?? undefined, guardians: guardians.length ? guardians : undefined });
  }

  let returnUrl: string | null = null;
  if (body.return_url !== undefined && body.return_url !== null && body.return_url !== "") {
    const u = str(body.return_url, 500);
    if (!u || !urlOnAllowedOrigin(u, allowedOrigins)) return bad("\"return_url\" must be on one of the allowed addresses registered for this key.", "return_url");
    returnUrl = u;
  }

  return {
    ok: true,
    value: {
      form,
      coach: { id: coachId, name: coachName, email: coachEmail, phone: coachPhone ?? null },
      activity: { id: actId, name: actName, venue: venue ?? null, date: date ?? null },
      roster,
      returnUrl,
    },
  };
}
