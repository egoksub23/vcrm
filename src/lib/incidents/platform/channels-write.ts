// Saving the Channels settings, and filing an incident from an email. Server side only (admin connection): the routes check who is asking first.

import { randomBytes } from "node:crypto";

import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import { incidentKey } from "@/lib/incidents/types";
import { loadChannelSettings, type ChannelSettings } from "./channels-data";
import type { ChannelSettingsPatch } from "./channels-input";
import { bodyFromText, parseAddress, senderAllowed, titleFromSubject, type EmailIn } from "./email-intake";
import { loadActiveTemplate } from "./setup-data";

const newToken = () => randomBytes(24).toString("base64url");

/** Save a patch from the Channels screen. The secret email-in address is made the first time email-in is switched on, or when asked for again. */
export async function saveChannelSettings(accountId: string, userId: string, patch: ChannelSettingsPatch, db: PgDb = createAdminPgDb()): Promise<ChannelSettings> {
  const current = await loadChannelSettings(db, accountId);
  const { regenerate_token, ...rest } = patch;
  const turningOn = (rest.email_in_enabled ?? current.email_in_enabled) === true;
  const token = regenerate_token || (turningOn && !current.email_in_token) ? newToken() : current.email_in_token;
  const row = { ...current, ...rest, email_in_token: token };
  const { error } = await db.from("incident_channel_settings").upsert({ account_id: accountId, ...row, updated_by: userId }, { onConflict: "account_id" });
  if (error) throw new Error("Could not save the channel settings.");
  return row;
}

export type EmailFiling =
  | { status: "created"; incidentId: string; reference: string }
  | { status: "duplicate"; reference: string }
  | { status: "unknown" }
  | { status: "forbidden" }
  | { status: "not_ready"; reason: string };

/**
 * File an incident from an email that arrived at a school's secret address. Only senders on the school's list are accepted; the same email (same message id)
 * twice files once; the incident goes in under the category the school chose and the template's second most serious level, and its sender is the reporter.
 * The caller then runs the "raised" rules, exactly as for an incident raised on screen.
 */
export async function fileIncidentFromEmail(token: string, mail: EmailIn, db: PgDb = createAdminPgDb()): Promise<EmailFiling> {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return { status: "unknown" };
  const { data: row } = await db.from("incident_channel_settings").select("account_id").eq("email_in_token", token).eq("email_in_enabled", true).maybeSingle();
  const accountId = (row as { account_id: string } | null)?.account_id;
  if (!accountId) return { status: "unknown" };

  const settings = await loadChannelSettings(db, accountId);
  const from = parseAddress(mail.from);
  if (!from || !senderAllowed(settings.email_in_senders, from.email)) return { status: "forbidden" };

  if (mail.messageId) {
    const { data: seen } = await db.from("incidents").select("id, created_at, incident_number").eq("account_id", accountId).eq("source", "email").eq("external_ref", mail.messageId).maybeSingle();
    const s = seen as { created_at: string; incident_number: number } | null;
    if (s) return { status: "duplicate", reference: incidentKey(s) };
  }

  const template = await loadActiveTemplate(db, accountId);
  if (!template) return { status: "not_ready", reason: "No incident template is active for this school." };
  const open = template.categories.filter((c) => !c.is_hidden);
  const category = open.find((c) => c.code === settings.email_in_category) ?? open[0];
  if (!category) return { status: "not_ready", reason: "This school has no category to file under." };
  const levels = [...template.severities].sort((a, b) => a.position - b.position).map((l) => l.slug);
  const severity = levels[Math.max(0, levels.length - 2)];
  if (!severity) return { status: "not_ready", reason: "This school has no severity levels." };

  const { data: num, error: numErr } = await db.rpc<number>("next_incident_number", { p_account_id: accountId });
  if (numErr || num == null) throw new Error("could not number the incident");

  const body = bodyFromText(mail.text);
  const { data, error } = await db
    .from("incidents")
    .insert({
      account_id: accountId,
      incident_number: num,
      title: titleFromSubject(mail.subject),
      description: body || null,
      incident_type: category.code,
      severity,
      detection_source: "staff",
      reporter_id: null,
      standard_id: template.standardId,
      incident_flags: category.default_flags ?? [],
      source: "email",
      external_ref: mail.messageId,
      reporter_name: from.name,
      reporter_email: from.email,
    })
    .select("id, created_at, incident_number")
    .single();
  if (error || !data) throw new Error("could not file the incident");
  const inc = data as { id: string; created_at: string; incident_number: number };
  return { status: "created", incidentId: inc.id, reference: incidentKey(inc) };
}
