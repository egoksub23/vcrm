// ============================================================
// Doc Sign: several signed files in one zip (POST /api/sign/documents/zip). Pure: which of the chosen documents
// can go in, what each file is called, and the limits that keep one request bounded. The route streams the zip.
//
// Only a completed document has a signed file (the sealed PDF), so the others are reported as skipped, with the reason, in a
// header and in a note inside the zip. A document sealed from migration 178 on has its certificate as a file of its own, which goes
// in the zip beside the signed file; an older one carries its certificate pages inside the signed file and has nothing more to add.
// ============================================================

import { safeFileName } from "../storage";

/** The most documents one zip holds. */
export const ZIP_MAX_DOCUMENTS = 50;
/** The most the signed files of one zip may weigh together (read one at a time, never all at once). */
export const ZIP_MAX_BYTES = 300 * 1024 * 1024;
/** The name of the note inside the zip that lists what was left out. */
export const ZIP_SKIPPED_NOTE = "NOT-INCLUDED.txt";

export type ZipSkipReason = "not_completed" | "no_signed_file" | "not_found" | "too_large" | "read_failed" | "certificate_read_failed";

export interface ZipCandidate {
  id: string;
  reference: string | null;
  title: string;
  status: string;
  final_path: string | null;
  /** Migration 178: the certificate as a file of its own; null or absent when it is inside the signed file. */
  certificate_path?: string | null;
}

export interface ZipSkip {
  id: string;
  reference: string | null;
  reason: ZipSkipReason;
}

/** The ids as a browser sent them: well formed ones only, each once. Null when there are none or more than the limit. */
export function cleanIds(raw: unknown, isId: (v: string) => boolean): string[] | null {
  if (!Array.isArray(raw) || raw.length > ZIP_MAX_DOCUMENTS * 4) return null;
  const ids = [...new Set(raw.filter((v): v is string => typeof v === "string" && isId(v)))];
  return ids.length === 0 || ids.length > ZIP_MAX_DOCUMENTS ? null : ids;
}

/**
 * Split the chosen documents into those that go in and those that are left out. `found` are the documents the
 * workspace has among the chosen ids (others do not exist or belong to another workspace: "not_found").
 */
export function classifyForZip(chosen: readonly string[], found: readonly ZipCandidate[]): { included: ZipCandidate[]; skipped: ZipSkip[] } {
  const byId = new Map(found.map((d) => [d.id, d]));
  const included: ZipCandidate[] = [];
  const skipped: ZipSkip[] = [];
  for (const id of chosen) {
    const d = byId.get(id);
    if (!d) skipped.push({ id, reference: null, reason: "not_found" });
    else if (d.status !== "completed") skipped.push({ id, reference: d.reference, reason: "not_completed" });
    else if (!d.final_path) skipped.push({ id, reference: d.reference, reason: "no_signed_file" });
    else included.push(d);
  }
  return { included, skipped };
}

/**
 * The name of a file in the zip: the reference and the title, made safe, ending in `.pdf`; with `suffix` (the certificate) " - certificate" goes
 * before the extension. A name already used (the comparison ignores case, as a Windows folder does) gets `-2`, `-3`... before the extension.
 * `used` is added to.
 */
export function zipEntryName(doc: Pick<ZipCandidate, "reference" | "title" | "id">, used: Set<string>, suffix?: string): string {
  // a slash in a title is a separator, not a folder: safeFileName would keep only what follows the last one
  const joined = [doc.reference, doc.title].filter(Boolean).join(" - ").replace(/[\\/]+/g, "-").replace(/\.{2,}/g, ".");
  const stem = (safeFileName(joined, doc.id.slice(0, 8)).replace(/\.+$/, "").slice(0, 100) || doc.id.slice(0, 8)) + (suffix ? ` - ${suffix}` : "");
  let name = `${stem}.pdf`;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem}-${n}.pdf`;
  used.add(name.toLowerCase());
  return name;
}

/** The text of the note that lists what was left out and why. Empty when nothing was. */
export function skippedNote(skipped: readonly ZipSkip[]): string {
  if (skipped.length === 0) return "";
  const why: Record<ZipSkipReason, string> = {
    not_completed: "not completed yet, so there is no signed file",
    no_signed_file: "completed, but no signed file was found",
    not_found: "not found in this workspace",
    too_large: "left out to keep this download within its size limit",
    read_failed: "the signed file could not be read",
    certificate_read_failed: "the signed file is in this zip, but its certificate could not be read",
  };
  return [
    "These documents are not in this zip:",
    "",
    ...skipped.map((s) => `- ${s.reference ?? s.id}: ${why[s.reason]}`),
    "",
  ].join("\r\n");
}

/** The file name of the zip: the date it was made. */
export const zipFileName = (now: Date): string => `signed-documents-${now.toISOString().slice(0, 10)}.zip`;
