// What the Channels screen sends (PUT /api/incidents/setup/channels), checked before anything is saved. Pure, so each rule has a test.

import { MAX_SENDERS, cleanSender } from "./email-intake";
import type { Parsed } from "./input";

export interface ChannelSettingsPatch {
  whatsapp_enabled?: boolean;
  whatsapp_template_name?: string | null;
  whatsapp_template_language?: string;
  sms_enabled?: boolean;
  push_enabled?: boolean;
  email_in_enabled?: boolean;
  email_in_senders?: string[];
  email_in_category?: string | null;
  /** Make a new secret address (the old one stops working). */
  regenerate_token?: boolean;
}

const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

export function parseChannelSettings(body: unknown, categoryCodes: readonly string[]): Parsed<ChannelSettingsPatch> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("Send the settings.");
  const b = body as Record<string, unknown>;
  const out: ChannelSettingsPatch = {};

  for (const k of ["whatsapp_enabled", "sms_enabled", "push_enabled", "email_in_enabled", "regenerate_token"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") return fail(`'${k}' must be true or false.`);
    out[k] = b[k] as boolean;
  }

  if (b.whatsapp_template_name !== undefined) {
    if (b.whatsapp_template_name === null || b.whatsapp_template_name === "") out.whatsapp_template_name = null;
    else if (typeof b.whatsapp_template_name !== "string" || !/^[a-z0-9_]{1,512}$/.test(b.whatsapp_template_name.trim())) {
      return fail("A WhatsApp template name uses lower-case letters, numbers and underscores only, for example incident_notice.");
    } else out.whatsapp_template_name = b.whatsapp_template_name.trim();
  }
  if (b.whatsapp_template_language !== undefined) {
    if (typeof b.whatsapp_template_language !== "string" || !/^[a-z]{2,3}(_[A-Za-z]{2})?$/.test(b.whatsapp_template_language.trim())) {
      return fail("A language code looks like en, ms or en_US.");
    }
    out.whatsapp_template_language = b.whatsapp_template_language.trim();
  }
  if (out.whatsapp_enabled === true && !out.whatsapp_template_name && b.whatsapp_template_name !== undefined) {
    return fail("Give the name of your approved WhatsApp template before switching WhatsApp on.");
  }

  if (b.email_in_senders !== undefined) {
    if (!Array.isArray(b.email_in_senders) || !b.email_in_senders.every((x) => typeof x === "string")) return fail("The allowed senders must be a list.");
    const cleaned: string[] = [];
    for (const raw of b.email_in_senders as string[]) {
      if (!raw.trim()) continue;
      const c = cleanSender(raw);
      if (!c) return fail(`"${raw.trim().slice(0, 60)}" is not an email address or a domain written like @school.edu.`);
      if (!cleaned.includes(c)) cleaned.push(c);
    }
    if (cleaned.length > MAX_SENDERS) return fail(`At most ${MAX_SENDERS} allowed senders.`);
    out.email_in_senders = cleaned;
  }
  if (b.email_in_category !== undefined) {
    if (b.email_in_category === null || b.email_in_category === "") out.email_in_category = null;
    else if (typeof b.email_in_category !== "string" || !categoryCodes.includes(b.email_in_category)) return fail("That category is not one of your categories.");
    else out.email_in_category = b.email_in_category;
  }
  return { ok: true, value: out };
}
