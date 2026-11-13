// Parsing and validating what the setup screens send. Pure, so each rule has a test; the routes only call these and map the message to a 400.

import { IMPLEMENTED_CHANNELS, cleanList, isPlausibleEmail, type ChannelKind, type NotifyMode } from "./roles";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

const CHANNELS: readonly ChannelKind[] = ["email", "whatsapp", "sms", "push"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

export interface ContactInput {
  name: string;
  kind: "staff" | "outside";
  emails: string[];
  phones: string[];
  preferred_channels: ChannelKind[];
  is_active: boolean;
  user_id: string | null;
}

/** A person to tell. At least one email is needed today, because email is the only channel that can send. */
export function parseContact(body: unknown, partial = false): Parsed<Partial<ContactInput>> {
  if (!isObj(body)) return fail("Send the person's details.");
  const out: Partial<ContactInput> = {};

  if (body.name !== undefined || !partial) {
    if (typeof body.name !== "string" || !body.name.trim()) return fail("Give the person a name.");
    if (body.name.trim().length > 120) return fail("The name is too long (120 characters at most).");
    out.name = body.name.trim();
  }
  if (body.kind !== undefined) {
    if (body.kind !== "staff" && body.kind !== "outside") return fail("Say whether this is staff or an outside contact.");
    out.kind = body.kind;
  }
  if (body.emails !== undefined || !partial) {
    const raw = strList(body.emails ?? []);
    if (!raw) return fail("Emails must be a list of addresses.");
    const emails = cleanList(raw, true);
    const bad = emails.find((e) => !isPlausibleEmail(e));
    if (bad) return fail(`"${bad}" does not look like an email address.`);
    if (emails.length > 5) return fail("Five email addresses at most per person.");
    out.emails = emails;
  }
  if (body.phones !== undefined) {
    const raw = strList(body.phones);
    if (!raw) return fail("Phones must be a list of numbers.");
    const phones = cleanList(raw);
    const bad = phones.find((p) => !/^\+?[0-9][0-9 ()-]{5,20}$/.test(p));
    if (bad) return fail(`"${bad}" does not look like a phone number. Use digits, with a leading + for the country code.`);
    if (phones.length > 5) return fail("Five phone numbers at most per person.");
    out.phones = phones;
  }
  if (body.preferred_channels !== undefined) {
    const raw = strList(body.preferred_channels);
    if (!raw || raw.some((c) => !CHANNELS.includes(c as ChannelKind))) return fail("Unknown channel.");
    out.preferred_channels = [...new Set(raw)] as ChannelKind[];
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") return fail("is_active must be true or false.");
    out.is_active = body.is_active;
  }
  if (body.user_id !== undefined) {
    if (body.user_id !== null && typeof body.user_id !== "string") return fail("user_id must be an id or null.");
    out.user_id = body.user_id as string | null;
  }
  if (!partial && (out.emails?.length ?? 0) === 0) return fail("Add at least one email address. Email is how people are told today.");
  if (partial && out.emails && out.emails.length === 0) return fail("A person needs at least one email address.");
  return { ok: true, value: out };
}

/** Roles are keyed by a slug made from their English name. */
export function roleKeyFrom(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(base) ? base : `role_${base}`;
}

export interface RoleInput {
  name: string;
  description: string | null;
  notify_mode: NotifyMode;
}

export function parseRole(body: unknown, partial = false): Parsed<Partial<RoleInput>> {
  if (!isObj(body)) return fail("Send the role's details.");
  const out: Partial<RoleInput> = {};
  if (body.name !== undefined || !partial) {
    if (typeof body.name !== "string" || body.name.trim().length < 2) return fail("Give the role a name (at least 2 characters).");
    if (body.name.trim().length > 80) return fail("The role name is too long (80 characters at most).");
    out.name = body.name.trim();
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") return fail("The description must be text.");
    out.description = body.description ? (body.description as string).trim().slice(0, 300) : null;
  }
  if (body.notify_mode !== undefined) {
    if (body.notify_mode !== "all" && body.notify_mode !== "first_available") return fail("Choose to tell everyone, or the first available person.");
    out.notify_mode = body.notify_mode;
  }
  return { ok: true, value: out };
}

export interface MemberPatch {
  position?: number;
  is_backup?: boolean;
  away_from?: string | null;
  away_to?: string | null;
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

export function parseMemberPatch(body: unknown): Parsed<MemberPatch> {
  if (!isObj(body)) return fail("Send the changes.");
  const out: MemberPatch = {};
  if (body.position !== undefined) {
    if (!Number.isInteger(body.position) || (body.position as number) < 0 || (body.position as number) > 999) return fail("Position must be a whole number.");
    out.position = body.position as number;
  }
  if (body.is_backup !== undefined) {
    if (typeof body.is_backup !== "boolean") return fail("is_backup must be true or false.");
    out.is_backup = body.is_backup;
  }
  for (const k of ["away_from", "away_to"] as const) {
    if (body[k] === undefined) continue;
    if (body[k] !== null && !isDate(body[k])) return fail("Dates look like 2026-11-20.");
    out[k] = body[k] as string | null;
  }
  if (out.away_from && out.away_to && out.away_to < out.away_from) return fail("The away dates are the wrong way round.");
  return { ok: true, value: out };
}

/** Channels a contact can really be reached on right now (for hints in the form). */
export function channelHint(preferred: readonly ChannelKind[]): string | null {
  const unsupported = preferred.filter((c) => !IMPLEMENTED_CHANNELS.includes(c));
  return unsupported.length ? `${unsupported.join(", ")} will be used when it is connected. Until then, email is used.` : null;
}
