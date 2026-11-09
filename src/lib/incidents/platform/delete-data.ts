// Deleting one incident for good (server side, after the route has checked the caller is the school's Owner and has typed the reference). Only a voided
// incident can be deleted. Its files (attachments and filed reports) are removed from storage, a line goes to incident_deletions (reference, title, who, why,
// when; no personal details), and the incident goes with everything under it (people named, notes, steps, notices, activity).

import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import { appStorage } from "@/lib/storage/provider";
import { referenceOf } from "./registers";

const BUCKET = "chat-media";

export type DeleteResult = { ok: true; reference: string; filesRemoved: number } | { ok: false; status: number; error: string };

export async function deleteIncidentForGood(args: { accountId: string; incidentId: string; userId: string; confirm: string; db?: PgDb }): Promise<DeleteResult> {
  const db = args.db ?? createAdminPgDb();
  const { data } = await db.from("incidents").select("id, incident_number, created_at, title, voided_at, void_reason").eq("id", args.incidentId).eq("account_id", args.accountId).maybeSingle();
  const inc = data as { id: string; incident_number: number; created_at: string | Date; title: string; voided_at: string | null; void_reason: string | null } | null;
  if (!inc) return { ok: false, status: 404, error: "Incident not found." };
  if (!inc.voided_at) return { ok: false, status: 409, error: "Void the incident first. Only a voided incident can be deleted." };
  const reference = referenceOf({ created_at: new Date(inc.created_at).toISOString(), incident_number: inc.incident_number });
  if (args.confirm.trim() !== reference) return { ok: false, status: 400, error: `Type the reference (${reference}) to confirm.` };

  const [atts, reports] = await Promise.all([
    db.from("incident_attachments").select("storage_path").eq("incident_id", inc.id),
    db.from("incident_filed_reports").select("storage_path").eq("incident_id", inc.id),
  ]);
  const paths = [...((atts.data ?? []) as { storage_path: string }[]), ...((reports.data ?? []) as { storage_path: string }[])].map((r) => r.storage_path).filter(Boolean);

  const log = await db.from("incident_deletions").insert({
    account_id: args.accountId,
    reference,
    incident_number: inc.incident_number,
    title: inc.title.slice(0, 200),
    void_reason: inc.void_reason,
    files_removed: paths.length,
    deleted_by: args.userId,
  });
  if (log.error) return { ok: false, status: 500, error: "Could not record the deletion. Nothing was deleted." };

  const { error } = await db.from("incidents").delete().eq("id", inc.id).eq("account_id", args.accountId);
  if (error) return { ok: false, status: 500, error: "Could not delete the incident." };
  if (paths.length > 0) await appStorage().from(BUCKET).remove(paths).catch(() => undefined);
  return { ok: true, reference, filesRemoved: paths.length };
}
