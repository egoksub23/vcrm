// The intake service's store on Halo's PostgreSQL (service connection: the caller is a machine or a coach with a link, never a signed-in user).

import { createHash, randomUUID } from "node:crypto";

import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import { DEFAULT_PLATFORM, isFeatureEnabled, parsePlatformRow } from "@/lib/platform/features";
import { checkRateLimit } from "@/lib/rate-limit";
import { appStorage } from "@/lib/storage/provider";
import { buildMediaPath } from "@/lib/storage/upload-media";
import { incidentKey } from "@/lib/incidents/types";
import { loadActiveTemplate } from "@/lib/incidents/platform/setup-data";
import { labelOf } from "@/lib/incidents/platform/roles";
import type { ClearanceRow, IntakeStore, KeyRow, NewIncident, SessionRow } from "./service";

const BUCKET = "chat-media";

export class PgIntakeStore implements IntakeStore {
  constructor(private readonly db: PgDb = createAdminPgDb()) {}

  async findKeyByHash(hash: string): Promise<KeyRow | null> {
    const { data } = await this.db.from("incident_intake_keys").select("id, account_id, mode, scopes, allowed_origins, revoked_at").eq("key_hash", hash).maybeSingle();
    return (data as KeyRow | null) ?? null;
  }

  async getKey(id: string): Promise<KeyRow | null> {
    const { data } = await this.db.from("incident_intake_keys").select("id, account_id, mode, scopes, allowed_origins, revoked_at").eq("id", id).maybeSingle();
    return (data as KeyRow | null) ?? null;
  }

  async touchKey(keyId: string, now: Date): Promise<void> {
    await this.db.from("incident_intake_keys").update({ last_used_at: now.toISOString() }).eq("id", keyId);
  }

  async logCall(accountId: string, keyId: string | null, route: string, status: number, summary: string): Promise<void> {
    try {
      await this.db.from("incident_intake_calls").insert({ account_id: accountId, key_id: keyId, route, status, summary: summary.slice(0, 300) });
    } catch {
      // The call log is a convenience; never fail a request because it could not be written.
    }
  }

  async accountEnabled(accountId: string): Promise<boolean> {
    const { data, error } = await this.db.from("account_platform").select("status, features").eq("account_id", accountId).maybeSingle();
    if (error) return false;
    const platform = data ? parsePlatformRow(data) : DEFAULT_PLATFORM;
    return platform.status === "active" && isFeatureEnabled(platform, "incidents");
  }

  async template(accountId: string) {
    const t = await loadActiveTemplate(this.db, accountId);
    if (!t) return null;
    return { standardId: t.standardId, categoryCodes: t.categories.map((c) => c.code), severities: t.severities.map((s) => ({ slug: s.slug, position: s.position })) };
  }

  async sessionByIdempotency(keyId: string, idem: string): Promise<SessionRow | null> {
    const { data } = await this.db.from("incident_intake_sessions").select("*").eq("key_id", keyId).eq("idempotency_key", idem).maybeSingle();
    return (data as SessionRow | null) ?? null;
  }

  async createSession(row: Omit<SessionRow, "submitted_at" | "incident_id">): Promise<SessionRow> {
    const { data, error } = await this.db.from("incident_intake_sessions").insert(row as unknown as Record<string, unknown>).select("*").single();
    if (error || !data) {
      // Two identical launches raced (same idempotency key): the second one reads the first one's row.
      if (row.idempotency_key) {
        const existing = await this.sessionByIdempotency(row.key_id, row.idempotency_key);
        if (existing) return existing;
      }
      throw new Error(`could not create the report link: ${error?.message ?? "unknown"}`);
    }
    return data as SessionRow;
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const { data } = await this.db.from("incident_intake_sessions").select("*").eq("id", id).maybeSingle();
    return (data as SessionRow | null) ?? null;
  }

  async createIncident(input: NewIncident): Promise<{ id: string; reference: string }> {
    const tpl = await loadActiveTemplate(this.db, input.accountId);
    const { data: num, error: numErr } = await this.db.rpc<number>("next_incident_number", { p_account_id: input.accountId });
    if (numErr || num == null) throw new Error(`could not number the incident: ${numErr?.message ?? "no number"}`);

    const { data, error } = await this.db
      .from("incidents")
      .insert({
        account_id: input.accountId,
        incident_number: num,
        title: input.title,
        description: input.description || null,
        incident_type: input.category,
        severity: input.severity,
        detection_source: "staff",
        reporter_id: null,
        standard_id: tpl?.standardId ?? null,
        incident_flags: input.flags,
        source: "coach_portal",
        external_ref: input.sessionId,
        reporter_name: input.coach.name,
        reporter_email: input.coach.email,
        reporter_phone: input.coach.phone,
        is_test: input.mode === "test",
        activity: input.activity,
        custom_fields: input.answers,
      })
      .select("id, created_at, incident_number")
      .single();
    if (error || !data) throw new Error(`could not file the incident: ${error?.message ?? "unknown"}`);
    const inc = data as { id: string; created_at: string; incident_number: number };

    if (input.involved.length > 0) {
      const injured = input.flags.includes("injury");
      const { error: invErr } = await this.db.from("incident_involved").insert(
        input.involved.map((p) => ({
          incident_id: inc.id,
          account_id: input.accountId,
          external_student_id: p.studentId,
          name: p.name,
          class_name: p.className,
          guardians: p.guardians,
          involvement: injured ? "injured" : "involved",
        })),
      );
      if (invErr) console.error("[incident-intake] could not save the people named:", invErr.message);
    }
    return { id: inc.id, reference: incidentKey(inc) };
  }

  async markSubmitted(sessionId: string, incidentId: string, now: Date): Promise<void> {
    await this.db.from("incident_intake_sessions").update({ submitted_at: now.toISOString(), incident_id: incidentId }).eq("id", sessionId);
  }

  async incidentReference(incidentId: string): Promise<string | null> {
    const { data } = await this.db.from("incidents").select("created_at, incident_number").eq("id", incidentId).maybeSingle();
    return data ? incidentKey(data as { created_at: string; incident_number: number }) : null;
  }

  async toldRoles(incidentId: string): Promise<string[]> {
    const { data: rows } = await this.db.from("incident_deliveries").select("account_id, role_key").eq("incident_id", incidentId);
    const deliveries = (rows ?? []) as { account_id: string; role_key: string }[];
    if (deliveries.length === 0) return [];
    const keys = [...new Set(deliveries.map((d) => d.role_key))];
    const { data: roles } = await this.db.from("incident_roles").select("key, name").eq("account_id", deliveries[0].account_id).in("key", keys);
    const names = new Map(((roles ?? []) as { key: string; name: Record<string, string> }[]).map((r) => [r.key, labelOf(r.name)]));
    return keys.map((k) => names.get(k) ?? k.replace(/_/g, " "));
  }

  async clearances(accountId: string, studentIds: string[], today: string): Promise<ClearanceRow[]> {
    const { data } = await this.db
      .from("person_clearances")
      .select("external_student_id, type, not_before, incident_id")
      .eq("account_id", accountId)
      .in("external_student_id", studentIds)
      .is("cleared_at", null)
      .gte("not_before", today)
      .order("not_before", { ascending: false });
    const rows = (data ?? []) as { external_student_id: string; type: string; not_before: string; incident_id: string | null }[];
    // One line per student: the latest date wins.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.external_student_id)) latest.set(r.external_student_id, r);
    const out: ClearanceRow[] = [];
    for (const r of latest.values()) {
      out.push({ external_student_id: r.external_student_id, type: r.type, not_before: r.not_before, incident_reference: r.incident_id ? await this.incidentReference(r.incident_id) : null });
    }
    return out;
  }

  async photoCount(incidentId: string): Promise<number> {
    const { count } = await this.db.from("incident_attachments").select("id", { count: "exact", head: true }).eq("incident_id", incidentId);
    return count ?? 0;
  }

  async savePhoto(args: { accountId: string; incidentId: string; filename: string; mime: string; bytes: Uint8Array }): Promise<void> {
    const path = buildMediaPath(args.accountId, args.filename || "photo", Date.now(), "incidents");
    const bucket = appStorage().from(BUCKET);
    const up = await bucket.upload(path, args.bytes, { contentType: args.mime, upsert: false });
    if (up.error) throw new Error(`could not store the file: ${up.error.message}`);
    const url = bucket.getPublicUrl(path).data.publicUrl;
    const { error } = await this.db.from("incident_attachments").insert({
      incident_id: args.incidentId,
      account_id: args.accountId,
      storage_path: path,
      url,
      filename: (args.filename || "photo").slice(0, 200),
      mime_type: args.mime,
      size_bytes: args.bytes.byteLength,
      uploaded_by: null,
      file_hash: createHash("sha256").update(args.bytes).digest("hex"),
    });
    if (error) {
      await bucket.remove([path]).catch(() => {});
      throw new Error(`could not save the attachment: ${error.message}`);
    }
  }

  newId(): string {
    return randomUUID();
  }

  now(): Date {
    return new Date();
  }

  rateLimit(id: string): boolean {
    return checkRateLimit(`incident-intake:${id}`, { limit: 120, windowMs: 60_000 }).success;
  }
}
