// Export and delete incident records for one school (service connection). The rules (what a cutoff means, what must be typed) are in retention.ts.
//
// "Closed on or before the cutoff" is the only thing that is ever deleted: an open incident is never removed, whatever its age.

import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import { appStorage } from "@/lib/storage/provider";
import { buildExport, cutoffForYears, type ExportBundle } from "./retention";

const BUCKET = "chat-media";
export const EXPORT_MAX_INCIDENTS = 2000;
const CHUNK = 200;

type Row = Record<string, unknown>;

function dayAfter(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** Ids of the incidents that would be covered: closed before the end of the cutoff day. */
export async function incidentIdsClosedBefore(db: PgDb, accountId: string, cutoff: string, limit = EXPORT_MAX_INCIDENTS + 1): Promise<string[]> {
  const { data } = await db
    .from("incidents")
    .select("id")
    .eq("account_id", accountId)
    .eq("status", "closed")
    .not("closed_at", "is", null)
    .lt("closed_at", dayAfter(cutoff))
    .order("closed_at", { ascending: true })
    .limit(limit);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

async function inChunks(ids: string[], fn: (chunk: string[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK) await fn(ids.slice(i, i + CHUNK));
}

export async function exportClosedBefore(db: PgDb, accountId: string, cutoff: string, now = new Date()): Promise<{ bundle: ExportBundle; truncated: boolean }> {
  const all = await incidentIdsClosedBefore(db, accountId, cutoff);
  const truncated = all.length > EXPORT_MAX_INCIDENTS;
  const ids = all.slice(0, EXPORT_MAX_INCIDENTS);
  const incidents: Row[] = [];
  const children: Record<string, Map<string, Row[]>> = { involved: new Map(), steps: new Map(), comments: new Map(), files: new Map(), messages: new Map() };
  const push = (kind: string, id: string, row: Row) => children[kind].set(id, [...(children[kind].get(id) ?? []), row]);

  await inChunks(ids, async (chunk) => {
    const [inc, involved, steps, comments, files, messages] = await Promise.all([
      db.from("incidents").select("*").in("id", chunk),
      db.from("incident_involved").select("incident_id, name, class_name, external_student_id, involvement, guardians").in("incident_id", chunk),
      db.from("incident_obligations").select("incident_id, title, party, role_key, due_at, status, completed_at").in("incident_id", chunk),
      db.from("incident_comments").select("incident_id, author_id, body, created_at").in("incident_id", chunk),
      db.from("incident_attachments").select("incident_id, filename, mime_type, size_bytes, url, created_at").in("incident_id", chunk),
      db.from("incident_deliveries").select("incident_id, role_key, recipient_name, channel, address, status, sent_at, acknowledged_at").in("incident_id", chunk),
    ]);
    incidents.push(...((inc.data ?? []) as Row[]));
    for (const r of (involved.data ?? []) as Row[]) push("involved", r.incident_id as string, r);
    for (const r of (steps.data ?? []) as Row[]) push("steps", r.incident_id as string, r);
    for (const r of (comments.data ?? []) as Row[]) push("comments", r.incident_id as string, r);
    for (const r of (files.data ?? []) as Row[]) push("files", r.incident_id as string, r);
    for (const r of (messages.data ?? []) as Row[]) push("messages", r.incident_id as string, r);
  });

  const withChildren = incidents.map((i) => ({
    ...i,
    people_named: children.involved.get(i.id as string) ?? [],
    required_steps: children.steps.get(i.id as string) ?? [],
    comments: children.comments.get(i.id as string) ?? [],
    files: children.files.get(i.id as string) ?? [],
    message_log: children.messages.get(i.id as string) ?? [],
  }));
  return { bundle: buildExport({ now, cutoff, incidents: withChildren }), truncated };
}

export interface PurgeResult {
  incidents: number;
  files: number;
}

/** Delete the closed incidents (and, through the database's cascades, their steps, comments, messages and people) and their stored files. Logged. */
export async function purgeClosedBefore(db: PgDb, accountId: string, cutoff: string, performedBy: string | null, auto: boolean): Promise<PurgeResult> {
  const ids = await incidentIdsClosedBefore(db, accountId, cutoff, 5000);
  let files = 0;
  const storage = appStorage().from(BUCKET);
  await inChunks(ids, async (chunk) => {
    const { data } = await db.from("incident_attachments").select("storage_path").in("incident_id", chunk);
    const paths = ((data ?? []) as { storage_path: string }[]).map((r) => r.storage_path).filter(Boolean);
    if (paths.length) {
      const removed = await storage.remove(paths);
      if (!removed.error) files += paths.length;
    }
    await db.from("incidents").delete().in("id", chunk).eq("account_id", accountId).eq("status", "closed");
  });
  await db.from("incident_retention_log").insert({ account_id: accountId, action: auto ? "auto_purge" : "purge", cutoff, incident_count: ids.length, file_count: files, performed_by: performedBy });
  return { incidents: ids.length, files };
}

export async function logExport(db: PgDb, accountId: string, cutoff: string, count: number, performedBy: string): Promise<void> {
  await db.from("incident_retention_log").insert({ account_id: accountId, action: "export", cutoff, incident_count: count, performed_by: performedBy });
}

/** Schools that chose an automatic period: remove what is past it. Runs once a day (the caller decides when). Returns what was removed per school. */
export async function autoPurgeAll(db: PgDb = createAdminPgDb(), now = new Date()): Promise<{ accountId: string; incidents: number }[]> {
  const { data } = await db.from("incident_settings").select("account_id, retention_years").not("retention_years", "is", null);
  const out: { accountId: string; incidents: number }[] = [];
  for (const s of (data ?? []) as { account_id: string; retention_years: number }[]) {
    const since = new Date(now.getTime() - 20 * 3_600_000).toISOString();
    const { data: recent } = await db.from("incident_retention_log").select("id").eq("account_id", s.account_id).eq("action", "auto_purge").gte("created_at", since).limit(1);
    if ((recent ?? []).length > 0) continue;
    const cutoff = cutoffForYears(s.retention_years, now);
    const result = await purgeClosedBefore(db, s.account_id, cutoff, null, true);
    out.push({ accountId: s.account_id, incidents: result.incidents });
  }
  return out;
}
