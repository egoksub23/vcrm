// Incident roles, contacts and who a role resolves to (migration 208). Pure functions: no database, no clock of their own, so every rule about
// away dates, backups and "first available" is testable.

/** Text in each language, English first: `{ "en": "Head of Sport" }`. Other languages are added later without a data change. */
export type LangMap = Record<string, string>;

export function labelOf(map: LangMap | null | undefined, lang = "en"): string {
  if (!map) return "";
  return map[lang] ?? map.en ?? Object.values(map)[0] ?? "";
}

export type RoleKind = "fixed" | "per_incident";
export type DynamicSource = "reporter" | "incident_lead" | "guardian";
export type NotifyMode = "all" | "first_available";
/** Channels that exist as a concept. Only the ones in IMPLEMENTED_CHANNELS can be sent today. */
export type ChannelKind = "email" | "whatsapp" | "sms" | "push";
export const IMPLEMENTED_CHANNELS: readonly ChannelKind[] = ["email"];

export interface IncidentContact {
  id: string;
  account_id: string;
  user_id: string | null;
  name: string;
  kind: "staff" | "outside";
  emails: string[];
  phones: string[];
  preferred_channels: ChannelKind[];
  is_active: boolean;
}

export interface IncidentRole {
  id: string;
  account_id: string;
  key: string;
  name: LangMap;
  description: string | null;
  kind: RoleKind;
  dynamic_source: DynamicSource | null;
  notify_mode: NotifyMode;
  sort_order: number;
  is_system: boolean;
}

export interface IncidentRoleMember {
  id: string;
  account_id: string;
  role_id: string;
  contact_id: string;
  position: number;
  away_from: string | null;
  away_to: string | null;
  is_backup: boolean;
}

/** Who a per-incident role points at, worked out by the caller from the incident (reporter, lead, guardians). */
export type DynamicPeople = Partial<Record<DynamicSource, DynamicPerson[]>>;
export interface DynamicPerson {
  name: string;
  emails: string[];
  phones: string[];
  userId?: string | null;
}

/** One person to tell, on one channel, at one address. */
export interface Recipient {
  contactId: string | null;
  userId: string | null;
  name: string;
  channel: ChannelKind;
  address: string;
  /** The role this recipient was reached through. */
  roleKey: string;
}

export type ResolveWarning =
  | "no_members"
  | "everyone_away"
  | "no_address"
  | "no_people_on_incident";

export interface ResolveResult {
  recipients: Recipient[];
  warnings: ResolveWarning[];
}

/** Is the member away on this date? Both ends inclusive; an open end means "from then on" / "until then". `today` is a YYYY-MM-DD string. */
export function isAway(member: Pick<IncidentRoleMember, "away_from" | "away_to">, today: string): boolean {
  const { away_from: from, away_to: to } = member;
  if (!from && !to) return false;
  if (from && today < from) return false;
  if (to && today > to) return false;
  return true;
}

/**
 * The channel and addresses to reach a person with. Walks their preferred channels in order and takes the first one that has an adapter AND an
 * address to use. Email goes to every address the person has (a role member can have several); other channels use the first phone.
 */
export function addressesFor(
  person: { emails: readonly string[]; phones: readonly string[]; preferred_channels?: readonly ChannelKind[] },
  available: readonly ChannelKind[] = IMPLEMENTED_CHANNELS,
): { channel: ChannelKind; addresses: string[] } | null {
  const order: readonly ChannelKind[] = person.preferred_channels?.length ? person.preferred_channels : ["email"];
  for (const channel of order) {
    if (!available.includes(channel)) continue;
    const list = channel === "email" ? person.emails.filter((e) => e.trim()) : person.phones.slice(0, 1).filter((p) => p.trim());
    if (list.length > 0) return { channel, addresses: [...new Set(list.map((a) => a.trim()))] };
  }
  // Fall back to email if the person has one but their preference has no adapter yet (a WhatsApp-only preference must not mean "never told").
  if (available.includes("email")) {
    const emails = person.emails.filter((e) => e.trim());
    if (emails.length > 0) return { channel: "email", addresses: [...new Set(emails.map((a) => a.trim()))] };
  }
  return null;
}

/**
 * Who a role resolves to right now.
 *   - A per-incident role (reporter, incident lead, parent or guardian) is read from `dynamic`.
 *   - A fixed role takes its members in order. Non-backups who are not away are told; if there are none, backups who are not away. With
 *     notify_mode "first_available" only the first of those is told.
 * Warnings say why nobody was found, so a screen can show "Head of Sport has nobody in it" before a real incident finds out.
 */
export function resolveRole(args: {
  role: Pick<IncidentRole, "key" | "kind" | "dynamic_source" | "notify_mode">;
  members: readonly IncidentRoleMember[];
  contacts: readonly IncidentContact[];
  dynamic?: DynamicPeople;
  today: string;
  available?: readonly ChannelKind[];
}): ResolveResult {
  const { role, members, contacts, dynamic, today } = args;
  const available = args.available ?? IMPLEMENTED_CHANNELS;
  const warnings: ResolveWarning[] = [];
  const recipients: Recipient[] = [];

  if (role.kind === "per_incident") {
    const people = (role.dynamic_source ? dynamic?.[role.dynamic_source] : undefined) ?? [];
    if (people.length === 0) {
      warnings.push("no_people_on_incident");
      return { recipients, warnings };
    }
    for (const p of people) {
      const reach = addressesFor({ emails: p.emails, phones: p.phones }, available);
      if (!reach) {
        if (!warnings.includes("no_address")) warnings.push("no_address");
        continue;
      }
      for (const address of reach.addresses) {
        recipients.push({ contactId: null, userId: p.userId ?? null, name: p.name, channel: reach.channel, address, roleKey: role.key });
      }
    }
    return { recipients, warnings };
  }

  const byId = new Map(contacts.map((c) => [c.id, c]));
  const ordered = [...members]
    .filter((m) => byId.get(m.contact_id)?.is_active)
    .sort((a, b) => a.position - b.position);
  if (ordered.length === 0) {
    warnings.push("no_members");
    return { recipients, warnings };
  }
  const present = (m: IncidentRoleMember) => !isAway(m, today);
  let chosen = ordered.filter((m) => !m.is_backup && present(m));
  if (chosen.length === 0) chosen = ordered.filter((m) => m.is_backup && present(m));
  if (chosen.length === 0) {
    warnings.push("everyone_away");
    return { recipients, warnings };
  }
  if (role.notify_mode === "first_available") chosen = chosen.slice(0, 1);

  for (const m of chosen) {
    const contact = byId.get(m.contact_id)!;
    const reach = addressesFor(contact, available);
    if (!reach) {
      if (!warnings.includes("no_address")) warnings.push("no_address");
      continue;
    }
    for (const address of reach.addresses) {
      recipients.push({ contactId: contact.id, userId: contact.user_id, name: contact.name, channel: reach.channel, address, roleKey: role.key });
    }
  }
  return { recipients, warnings };
}

/** Light email check for the contact form: one @, something either side, a dot in the domain. Not a deliverability guarantee. */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value.trim());
}

/** Tidy a list typed or pasted into a form: trims, drops blanks and repeats (case-insensitive for emails). */
export function cleanList(values: readonly string[], lower = false): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = lower ? raw.trim().toLowerCase() : raw.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}
