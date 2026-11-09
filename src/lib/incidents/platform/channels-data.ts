// A school's channel settings (migration 228): which of WhatsApp, SMS and push it has switched on, the WhatsApp template, and the email-in address. Reads and
// writes go through one place so the engine, the setup screen and the email-in route agree on what "available" means.

import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import { decrypt } from "@/lib/whatsapp/encryption";
import { sendTemplateMessage } from "@/lib/whatsapp/meta-api";
import { availableChannels, createPushAdapter, createSmsAdapter, createWhatsAppAdapter, type ChannelSetup } from "./channel-adapters";
import type { ChannelAdapter } from "./adapters";
import type { ChannelKind } from "./roles";

export interface ChannelSettings {
  whatsapp_enabled: boolean;
  whatsapp_template_name: string | null;
  whatsapp_template_language: string;
  sms_enabled: boolean;
  push_enabled: boolean;
  email_in_enabled: boolean;
  email_in_token: string | null;
  email_in_senders: string[];
  email_in_category: string | null;
}

export const NO_CHANNEL_SETTINGS: ChannelSettings = {
  whatsapp_enabled: false,
  whatsapp_template_name: null,
  whatsapp_template_language: "en",
  sms_enabled: false,
  push_enabled: false,
  email_in_enabled: false,
  email_in_token: null,
  email_in_senders: [],
  email_in_category: null,
};

type Env = Record<string, string | undefined>;

/** What the server itself is set up for (SMS bridge, push API). The school can only switch on what the server can do. */
export function serverChannels(env: Env = process.env): { sms: boolean; push: boolean } {
  return {
    sms: Boolean(env.INCIDENT_SMS_URL?.trim() && env.INCIDENT_SMS_TOKEN?.trim()),
    push: Boolean(env.INCIDENT_PUSH_API_URL?.trim() && env.INCIDENT_PUSH_API_KEY?.trim() && (env.INCIDENT_PUSH_API_STAGE === "uat" || env.INCIDENT_PUSH_API_STAGE === "prod")),
  };
}

export async function loadChannelSettings(db: PgDb, accountId: string): Promise<ChannelSettings> {
  const { data } = await db.from("incident_channel_settings").select("*").eq("account_id", accountId).maybeSingle();
  const r = data as Partial<ChannelSettings> | null;
  if (!r) return { ...NO_CHANNEL_SETTINGS };
  return {
    whatsapp_enabled: r.whatsapp_enabled === true,
    whatsapp_template_name: r.whatsapp_template_name ?? null,
    whatsapp_template_language: r.whatsapp_template_language || "en",
    sms_enabled: r.sms_enabled === true,
    push_enabled: r.push_enabled === true,
    email_in_enabled: r.email_in_enabled === true,
    email_in_token: r.email_in_token ?? null,
    email_in_senders: r.email_in_senders ?? [],
    email_in_category: r.email_in_category ?? null,
  };
}

/** Is a WhatsApp number connected and switched on for this school (Settings, Channels)? */
export async function whatsappConnected(db: PgDb, accountId: string): Promise<boolean> {
  const { data } = await db.from("whatsapp_config").select("phone_number_id, access_token, enabled").eq("account_id", accountId).maybeSingle();
  const c = data as { phone_number_id?: string; access_token?: string; enabled?: boolean } | null;
  return Boolean(c?.phone_number_id && c.access_token && c.enabled !== false);
}

/** The channels a school can use right now. */
export function setupFrom(settings: ChannelSettings, connected: boolean, server = serverChannels()): ChannelSetup {
  return {
    whatsapp: settings.whatsapp_enabled && connected && Boolean(settings.whatsapp_template_name),
    sms: settings.sms_enabled && server.sms,
    push: settings.push_enabled && server.push,
  };
}

export async function availableChannelsFor(db: PgDb, accountId: string): Promise<ChannelKind[]> {
  const settings = await loadChannelSettings(db, accountId);
  const connected = settings.whatsapp_enabled ? await whatsappConnected(db, accountId) : false;
  return availableChannels(setupFrom(settings, connected));
}

/** The three real adapters, reading the school's settings when a notice is sent. */
export function realChannelAdapters(db: () => PgDb = createAdminPgDb): ChannelAdapter[] {
  return [
    createWhatsAppAdapter({
      async loadConfig(accountId) {
        const { data } = await db().from("whatsapp_config").select("phone_number_id, access_token, enabled").eq("account_id", accountId).maybeSingle();
        const c = data as { phone_number_id: string; access_token: string; enabled?: boolean } | null;
        return c ? { phoneNumberId: String(c.phone_number_id), accessToken: decrypt(String(c.access_token)), enabled: c.enabled !== false } : null;
      },
      async loadTemplate(accountId) {
        const s = await loadChannelSettings(db(), accountId);
        return s.whatsapp_enabled && s.whatsapp_template_name ? { name: s.whatsapp_template_name, language: s.whatsapp_template_language } : null;
      },
      sendTemplate: (args) => sendTemplateMessage(args),
    }),
    createSmsAdapter({ url: process.env.INCIDENT_SMS_URL?.trim() || null, secret: process.env.INCIDENT_SMS_TOKEN?.trim() || null }),
    createPushAdapter({
      url: process.env.INCIDENT_PUSH_API_URL?.trim() || null,
      secret: process.env.INCIDENT_PUSH_API_KEY?.trim() || null,
      stage: process.env.INCIDENT_PUSH_API_STAGE === "uat" || process.env.INCIDENT_PUSH_API_STAGE === "prod" ? process.env.INCIDENT_PUSH_API_STAGE : null,
    }),
  ];
}
