// Email to incident: the pure parts. A mail service posts each email it receives to the school's secret address; these functions decide whether the sender is
// allowed, and turn the email into the title, description and reporter of an incident. No database, no clock.

import { isPlausibleEmail } from "./roles";

export const MAX_EMAIL_TITLE = 200;
export const MAX_EMAIL_BODY = 10000;
export const MAX_SENDERS = 50;

export interface EmailIn {
  from: string;
  subject: string;
  text: string;
  messageId: string | null;
}

/** "Aiman <aiman@school.edu>", "<aiman@school.edu>" or "aiman@school.edu" -> the name (if any) and the lower-cased address. */
export function parseAddress(from: unknown): { name: string | null; email: string } | null {
  if (typeof from !== "string") return null;
  const angle = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (angle ? angle[2] : from).trim().toLowerCase();
  if (!isPlausibleEmail(email)) return null;
  const name = angle?.[1]?.trim();
  return { name: name ? name.slice(0, 120) : null, email };
}

/** One allowed sender: a full address or a whole domain written "@school.edu". Returns the cleaned entry, or null when it is neither. */
export function cleanSender(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) return v;
  return isPlausibleEmail(v) ? v : null;
}

/** Is this address on the school's list? An empty list allows nobody. */
export function senderAllowed(list: readonly string[], email: string): boolean {
  const e = email.trim().toLowerCase();
  const domain = e.slice(e.lastIndexOf("@"));
  return list.some((s) => {
    const v = s.trim().toLowerCase();
    return v === e || (v.startsWith("@") && v === domain);
  });
}

/** The subject without "Re:", "Fwd:" and the like, kept to one line. */
export function titleFromSubject(subject: unknown): string {
  const s = typeof subject === "string" ? subject : "";
  const cleaned = s.replace(/^\s*((re|fwd?|fw|aw|sv|vs)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim();
  return (cleaned || "Incident reported by email").slice(0, MAX_EMAIL_TITLE);
}

/** The words the person wrote: quoted replies (lines starting ">") and everything below "On ... wrote:" are dropped, and the length is capped. */
export function bodyFromText(text: unknown): string {
  const raw = typeof text === "string" ? text.replace(/\r\n?/g, "\n") : "";
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (/^\s*(on .{5,200} wrote:|-{2,}\s*(original message|forwarded message)\s*-{2,})\s*$/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line.replace(/\s+$/, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_EMAIL_BODY);
}

/** Read the JSON a mail service posts. Accepts a few common field names; returns null when there is no usable sender. */
export function parseEmailIn(body: unknown): EmailIn | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const from = typeof b.from === "string" ? b.from : typeof b.sender === "string" ? b.sender : null;
  if (!from || !parseAddress(from)) return null;
  const text = typeof b.text === "string" ? b.text : typeof b.plain === "string" ? b.plain : typeof b.body === "string" ? b.body : "";
  const idRaw = b.message_id ?? b.messageId ?? b["Message-ID"];
  const messageId = typeof idRaw === "string" && idRaw.trim() ? idRaw.trim().slice(0, 300) : null;
  return { from, subject: typeof b.subject === "string" ? b.subject : "", text, messageId };
}
