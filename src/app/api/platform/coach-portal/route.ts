// /api/platform/coach-portal — the coach portal as one platform integration, run by the Halo operator (not by each school).
//   GET    the platform keys (never the key itself, only its first characters), the Vircle Groups mapped to schools, the schools to choose from, Halo's address
//   POST   { mode: "live" | "test", label? } make a platform key. The key is in the answer ONCE; only its hash is stored.
//   PATCH  { key_id, label? | webhook_url? | revoke? } rename a key, set where events are sent, or revoke it
//   PUT    { group_id, group_name, account_id, allowed_origins?, enabled? } map a Vircle Group to a school (or change that mapping)
//   DELETE ?group_id=...  remove a mapping (its open report links stop working)
// Operator only (requirePlatformAdmin). The tables are written through the service connection: no school can change any of this.
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { buildHandoffGuide, parseKeyCreate, parseKeyPatch, parseSchool } from "@/lib/incidents/intake/admin";
import { generateKey } from "@/lib/incidents/intake/keys";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { createAdminPgDb } from "@/lib/postgres/db";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const KEY_COLUMNS = "id, label, mode, prefix, scopes, webhook_url, created_at, last_used_at, revoked_at";
const MAX_ACTIVE_KEYS = 6;

async function operator() {
  const ctx = await requirePlatformAdmin();
  const limit = checkRateLimit(`platform:coach-portal:${ctx.userId}`, RATE_LIMITS.adminAction);
  return { ctx, limited: limit.success ? null : rateLimitResponse(limit) };
}

export async function GET() {
  try {
    await requirePlatformAdmin();
    const db = createAdminPgDb();
    const [keys, schools, accounts, calls] = await Promise.all([
      db.from("incident_intake_keys").select(KEY_COLUMNS).is("account_id", null).order("created_at", { ascending: false }),
      db.from("incident_portal_schools").select("id, group_id, group_name, account_id, allowed_origins, enabled, created_at, updated_at").order("group_name", { ascending: true }),
      db.from("accounts").select("id, name").order("name", { ascending: true }),
      db.from("incident_intake_calls").select("id, account_id, route, status, summary, created_at").order("created_at", { ascending: false }).limit(20),
    ]);
    const keyRows = (keys.data ?? []) as { prefix: string; mode: string; revoked_at: string | null }[];
    const names = new Map(((accounts.data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]));
    const schoolRows = ((schools.data ?? []) as { account_id: string; allowed_origins: string[] }[]).map((s) => ({ ...s, account_name: names.get(s.account_id) ?? null }));
    const address = process.env.NEXT_PUBLIC_SITE_URL?.trim() || null;
    const live = keyRows.find((k) => k.mode === "live" && !k.revoked_at) ?? keyRows.find((k) => !k.revoked_at) ?? null;
    return NextResponse.json(
      {
        keys: keyRows,
        schools: schoolRows,
        accounts: accounts.data ?? [],
        calls: ((calls.data ?? []) as { account_id: string }[]).map((c) => ({ ...c, account_name: names.get(c.account_id) ?? null })),
        address,
        guide: buildHandoffGuide({ address, keyPrefix: live?.prefix ?? null, origins: schoolRows[0]?.allowed_origins ?? [] }),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { ctx, limited } = await operator();
    if (limited) return limited;
    const parsed = parseKeyCreate(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const db = createAdminPgDb();
    const { data: existing } = await db.from("incident_intake_keys").select("id").is("account_id", null).is("revoked_at", null);
    if ((existing ?? []).length >= MAX_ACTIVE_KEYS) return NextResponse.json({ error: "There are already six active keys. Revoke one you no longer use first." }, { status: 409 });

    const { key, prefix, hash } = generateKey(parsed.value.mode);
    const { data, error } = await db
      .from("incident_intake_keys")
      .insert({ account_id: null, label: parsed.value.label, mode: parsed.value.mode, prefix, key_hash: hash, created_by: ctx.userId })
      .select(KEY_COLUMNS)
      .single();
    if (error || !data) {
      console.error("[POST /api/platform/coach-portal]", error);
      return NextResponse.json({ error: "Could not create the key." }, { status: 500 });
    }
    return NextResponse.json({ key: data, secret: key }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const { limited } = await operator();
    if (limited) return limited;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const keyId = typeof body?.key_id === "string" ? body.key_id : "";
    if (!keyId) return NextResponse.json({ error: "Choose a key." }, { status: 400 });
    const parsed = parseKeyPatch(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const patch: Record<string, unknown> = {};
    if (parsed.value.label !== undefined) patch.label = parsed.value.label;
    if (parsed.value.webhookUrl !== undefined) patch.webhook_url = parsed.value.webhookUrl;
    if (parsed.value.revoke) patch.revoked_at = new Date().toISOString();

    const { data, error } = await createAdminPgDb().from("incident_intake_keys").update(patch).eq("id", keyId).is("account_id", null).is("revoked_at", null).select(KEY_COLUMNS).maybeSingle();
    if (error) return NextResponse.json({ error: "Could not save the changes." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Key not found, or it was already revoked." }, { status: 404 });
    return NextResponse.json({ key: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const { ctx, limited } = await operator();
    if (limited) return limited;
    const parsed = parseSchool(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const s = parsed.value;

    const db = createAdminPgDb();
    const { data: account } = await db.from("accounts").select("id").eq("id", s.accountId).maybeSingle();
    if (!account) return NextResponse.json({ error: "That school does not exist." }, { status: 404 });

    const row = { group_name: s.groupName, account_id: s.accountId, allowed_origins: s.allowedOrigins, enabled: s.enabled };
    const { data: existing } = await db.from("incident_portal_schools").select("id").eq("group_id", s.groupId).maybeSingle();
    const res = existing
      ? await db.from("incident_portal_schools").update(row).eq("group_id", s.groupId).select("*").single()
      : await db.from("incident_portal_schools").insert({ ...row, group_id: s.groupId, created_by: ctx.userId }).select("*").single();
    if (res.error || !res.data) {
      console.error("[PUT /api/platform/coach-portal]", res.error);
      return NextResponse.json({ error: "Could not save the school." }, { status: 500 });
    }
    return NextResponse.json({ school: res.data }, { status: existing ? 200 : 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const { limited } = await operator();
    if (limited) return limited;
    const groupId = new URL(request.url).searchParams.get("group_id")?.trim();
    if (!groupId) return NextResponse.json({ error: "Choose the Vircle Group to remove." }, { status: 400 });
    const { data, error } = await createAdminPgDb().from("incident_portal_schools").delete().eq("group_id", groupId).select("id").maybeSingle();
    if (error) return NextResponse.json({ error: "Could not remove the school." }, { status: 500 });
    if (!data) return NextResponse.json({ error: "That Vircle Group is not set up." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
