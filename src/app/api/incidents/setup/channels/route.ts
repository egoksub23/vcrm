// /api/incidents/setup/channels — how people are told (WhatsApp, SMS, push, besides email) and the email-in address. Requires incidents.configure.
//   GET   the school's settings, what the server is set up for, whether WhatsApp is connected, the channels usable right now, the categories, and the
//         secret email-in address (when switched on)
//   PUT   a patch of the settings, e.g. { sms_enabled: true } or { email_in_enabled: true, email_in_senders: ["@school.edu"], email_in_category: "cca_injury" };
//         { regenerate_token: true } makes a new secret address (the old one stops working)
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { createAdminPgDb } from "@/lib/postgres/db";
import { availableChannelsFor, loadChannelSettings, serverChannels, whatsappConnected } from "@/lib/incidents/platform/channels-data";
import { parseChannelSettings } from "@/lib/incidents/platform/channels-input";
import { saveChannelSettings } from "@/lib/incidents/platform/channels-write";
import { loadActiveTemplate } from "@/lib/incidents/platform/setup-data";

async function view(accountId: string) {
  const db = createAdminPgDb();
  const [settings, connected, template, available] = await Promise.all([
    loadChannelSettings(db, accountId),
    whatsappConnected(db, accountId),
    loadActiveTemplate(db, accountId),
    availableChannelsFor(db, accountId),
  ]);
  const base = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") || null;
  return {
    settings,
    server: serverChannels(),
    whatsapp_connected: connected,
    available,
    categories: (template?.categories ?? []).filter((c) => !c.is_hidden).map((c) => ({ code: c.code, name: c.name })),
    email_in_url: settings.email_in_enabled && settings.email_in_token ? `${base ?? ""}/api/public/incident-email-in/${settings.email_in_token}` : null,
  };
}

export async function GET() {
  try {
    const ctx = await requireCapability("incidents.configure");
    return NextResponse.json(await view(ctx.accountId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireCapability("incidents.configure");
    const template = await loadActiveTemplate(createAdminPgDb(), ctx.accountId);
    const parsed = parseChannelSettings(await request.json().catch(() => null), (template?.categories ?? []).map((c) => c.code));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    try {
      await saveChannelSettings(ctx.accountId, ctx.userId, parsed.value);
    } catch {
      return NextResponse.json({ error: "Could not save the settings." }, { status: 500 });
    }
    return NextResponse.json(await view(ctx.accountId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
