// ============================================================
// /api/incidents/settings/contact
//
//   PATCH — body `{ name?, role?, mobile?, email? }` (each a string or
//           null). Updates the account's 24/7 incident contact —
//           accounts.incident_contact_* (migration 123), pre-filled
//           into every generated Form A/D. A dedicated route rather
//           than folding into the generic account-settings route,
//           keeping the incidents.manage capability boundary explicit
//           at the route level (accounts_capability_guard() also
//           enforces it at the DB layer regardless).
// ============================================================
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";

export async function PATCH(request: Request) {
  try {
    const ctx = await requireCapability("incidents.manage");

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      role?: unknown;
      mobile?: unknown;
      email?: unknown;
    } | null;

    const update: Record<string, unknown> = {};
    const fields: [string, string][] = [
      ["name", "incident_contact_name"],
      ["role", "incident_contact_role"],
      ["mobile", "incident_contact_mobile"],
      ["email", "incident_contact_email"],
    ];
    for (const [key, column] of fields) {
      const value = (body as Record<string, unknown> | null)?.[key];
      if (value === undefined) continue;
      if (value !== null && typeof value !== "string") {
        return NextResponse.json({ error: `${key} must be a string or null` }, { status: 400 });
      }
      update[column] = value === null ? null : value.trim() || null;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const { data, error } = await ctx.supabase
      .from("accounts")
      .update(update)
      .eq("id", ctx.accountId)
      .select("incident_contact_name, incident_contact_role, incident_contact_mobile, incident_contact_email")
      .single();

    if (error) {
      console.error("[PATCH /api/incidents/settings/contact] update error:", error);
      return NextResponse.json({ error: "Failed to save the incident contact" }, { status: 500 });
    }

    return NextResponse.json({ contact: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
