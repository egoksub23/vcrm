// Makes and lists the filed reports of closed incidents (server side). The PDF is built from the evidence document, kept in file storage and linked to the
// incident by a row in incident_filed_reports (migration 221), so it can be listed on the incident and downloaded again.

import { createHash, randomUUID } from "node:crypto";

import { createAdminPgDb, type PgDb } from "@/lib/postgres/db";
import { appStorage } from "@/lib/storage/provider";
import { loadEvidenceDoc } from "./evidence-doc";
import { buildFilingPdf, type FilingImage } from "./filing-report";

export const FILING_BUCKET = "chat-media";
const MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

export interface FiledReport {
  id: string;
  incident_id: string;
  version: number;
  reference: string;
  filename: string;
  size_bytes: number;
  file_hash: string | null;
  incident_closed_at: string | null;
  generated_by: string | null;
  generated_by_name?: string | null;
  generated_at: string;
}

const COLUMNS = "id, incident_id, version, reference, filename, size_bytes, file_hash, incident_closed_at, generated_by, generated_at";

/** JPEG and PNG are the formats the PDF can hold. Decided by the file's first bytes, not by what it was called. */
export function imageKind(bytes: Uint8Array): "jpg" | "png" | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return null;
}

const isPicture = (a: { mime_type: string; filename: string }) => a.mime_type.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(a.filename);

export async function listFiledReports(db: PgDb, incidentId: string, accountId: string): Promise<FiledReport[]> {
  const { data } = await db.from("incident_filed_reports").select(COLUMNS).eq("incident_id", incidentId).eq("account_id", accountId).order("version", { ascending: false });
  const rows = ((data ?? []) as FiledReport[]).map((r) => ({ ...r, incident_closed_at: r.incident_closed_at ? new Date(r.incident_closed_at as unknown as string).toISOString() : null, generated_at: new Date(r.generated_at as unknown as string).toISOString() }));
  const ids = [...new Set(rows.map((r) => r.generated_by).filter((x): x is string => !!x))];
  if (ids.length > 0) {
    const { data: profiles } = await createAdminPgDb().from("profiles").select("user_id, full_name, email").in("user_id", ids).eq("account_id", accountId);
    const nameOf = new Map(((profiles ?? []) as { user_id: string; full_name: string | null; email: string | null }[]).map((p) => [p.user_id, p.full_name?.trim() || p.email || null]));
    for (const r of rows) r.generated_by_name = r.generated_by ? nameOf.get(r.generated_by) ?? null : null;
  }
  return rows;
}

export type GenerateResult = { ok: true; report: FiledReport; unsupportedCharacters: number; picturesNotShown: number } | { ok: false; status: number; error: string };

export async function generateFilingReport(args: {
  db: PgDb;
  accountId: string;
  accountName: string;
  userId: string;
  incidentId: string;
  canMedical: boolean;
  timeZone: string;
  narrative?: string | null;
}): Promise<GenerateResult> {
  const { db, accountId, incidentId } = args;
  const admin = createAdminPgDb();
  const doc = await loadEvidenceDoc({ db, accountId, incidentId, canMedical: args.canMedical, admin });
  if (!doc) return { ok: false, status: 404, error: "Incident not found." };
  if (doc.incident.status !== "closed") return { ok: false, status: 409, error: "Close the incident first. A report for filing is made once it is closed." };
  if (doc.incident.is_test) return { ok: false, status: 409, error: "This is a test report, so there is nothing to file." };

  // Pictures: the originals from storage, as many as the PDF can reasonably hold.
  const { data: atts } = await db.from("incident_attachments").select("filename, mime_type, size_bytes, storage_path, created_at").eq("incident_id", incidentId).eq("account_id", accountId).order("created_at");
  const pictures = ((atts ?? []) as { filename: string; mime_type: string; size_bytes: number; storage_path: string; created_at: string }[]).filter(isPicture);
  const images: FilingImage[] = [];
  const notShown: string[] = [];
  let total = 0;
  for (const a of pictures) {
    if (images.length >= MAX_IMAGES || a.size_bytes > MAX_IMAGE_BYTES || total + a.size_bytes > MAX_TOTAL_BYTES) {
      notShown.push(a.filename);
      continue;
    }
    const { data: blob } = await appStorage().from(FILING_BUCKET).download(a.storage_path);
    if (!blob) {
      notShown.push(a.filename);
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const kind = imageKind(bytes);
    if (!kind) {
      notShown.push(a.filename);
      continue;
    }
    total += bytes.length;
    images.push({ filename: a.filename, bytes, kind, addedAt: new Date(a.created_at).toISOString() });
  }

  const { data: me } = await admin.from("profiles").select("full_name, email").eq("user_id", args.userId).maybeSingle();
  const generatedBy = (me as { full_name: string | null; email: string | null } | null)?.full_name?.trim() || (me as { email: string | null } | null)?.email || null;

  const { data: latest } = await db.from("incident_filed_reports").select("version").eq("incident_id", incidentId).order("version", { ascending: false }).limit(1);
  const version = (((latest ?? []) as { version: number }[])[0]?.version ?? 0) + 1;

  const pdf = await buildFilingPdf({ doc, schoolName: args.accountName, generatedBy, version, timeZone: args.timeZone, images, imagesNotShown: notShown, narrative: args.narrative });

  const filename = `${doc.reference}-incident-report-v${version}.pdf`;
  const storagePath = `account-${accountId}/incidents/reports/${incidentId}-v${version}-${randomUUID()}.pdf`;
  const up = await appStorage().from(FILING_BUCKET).upload(storagePath, pdf.bytes, { contentType: "application/pdf", upsert: false });
  if (up.error) return { ok: false, status: 500, error: "Could not save the report. Try again." };

  const { data: row, error } = await db
    .from("incident_filed_reports")
    .insert({
      incident_id: incidentId,
      account_id: accountId,
      version,
      reference: doc.reference,
      filename,
      storage_path: storagePath,
      size_bytes: pdf.bytes.length,
      file_hash: createHash("sha256").update(pdf.bytes).digest("hex"),
      incident_closed_at: doc.incident.closed_at,
      generated_by: args.userId,
    })
    .select(COLUMNS)
    .single();
  if (error || !row) {
    void appStorage().from(FILING_BUCKET).remove([storagePath]).catch(() => {});
    return { ok: false, status: error?.message?.includes("closed") ? 409 : 500, error: error?.message?.includes("closed") ? "Close the incident first." : "Could not save the report. Try again." };
  }
  const report = { ...(row as FiledReport), generated_by_name: generatedBy, generated_at: new Date((row as FiledReport).generated_at as unknown as string).toISOString() };
  return { ok: true, report, unsupportedCharacters: pdf.unsupportedCharacters, picturesNotShown: notShown.length };
}

/** The stored PDF for one filed report, or null when it is not this school's / not visible to this person. */
export async function readFiledReport(db: PgDb, accountId: string, incidentId: string, reportId: string): Promise<{ filename: string; bytes: Uint8Array } | null> {
  const { data } = await db.from("incident_filed_reports").select("filename, storage_path").eq("id", reportId).eq("incident_id", incidentId).eq("account_id", accountId).maybeSingle();
  const row = data as { filename: string; storage_path: string } | null;
  if (!row) return null;
  const { data: blob } = await appStorage().from(FILING_BUCKET).download(row.storage_path);
  if (!blob) return null;
  return { filename: row.filename, bytes: new Uint8Array(await blob.arrayBuffer()) };
}
