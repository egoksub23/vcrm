import { deleteAccountMedia, uploadAccountMedia } from "@/lib/storage/upload-media";
import type { IncidentAttachment } from "./types";

const BUCKET = "chat-media";
const SUBFOLDER = "incidents";

/**
 * Upload one evidence file (screenshot, log bundle, zip) and file it
 * under the incident — and, through the incident_evidence_log trigger
 * (migration 116), the chain-of-custody log automatically. Deliberately
 * does NOT recompress images the way attachFileToTicket does: evidence
 * integrity means uploading the original bytes, not a re-encoded copy.
 * Throws with a message the caller can show.
 */
/** SHA-256 of the file's bytes, hex-encoded — the evidence chain-of-custody
 *  hash (Appendix F.2 / Form B §9). Computed client-side (Web Crypto) since
 *  this upload path is entirely client-direct-to-storage, with no server
 *  route to hash on. Runs in parallel with the storage upload. */
async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function attachFileToIncident(
  incident: { id: string },
  file: File,
  _userId: string,
  commentId?: string,
): Promise<IncidentAttachment> {
  const [{ publicUrl, path }, fileHash] = await Promise.all([
    uploadAccountMedia(BUCKET, file, SUBFOLDER),
    sha256Hex(file),
  ]);
  const res = await fetch(`/api/incidents/${encodeURIComponent(incident.id)}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storage_path: path,
      url: publicUrl,
      filename: file.name || 'file',
      mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
      comment_id: commentId ?? null,
      file_hash: fileHash,
    }),
  }).catch(() => null);
  if (!res?.ok) {
    void deleteAccountMedia(BUCKET, path).catch(() => {});
    throw new Error('Could not save the attachment.');
  }
  const json = (await res.json().catch(() => null)) as { attachment?: IncidentAttachment } | null;
  if (!json?.attachment) {
    void deleteAccountMedia(BUCKET, path).catch(() => {});
    throw new Error('Could not save the attachment.');
  }
  return json.attachment;
}

export async function removeIncidentAttachment(att: IncidentAttachment): Promise<boolean> {
  const res = await fetch(
    `/api/incidents/${encodeURIComponent(att.incident_id)}/attachments/${encodeURIComponent(att.id)}`,
    { method: 'DELETE' },
  ).catch(() => null);
  if (!res?.ok) return false;
  void deleteAccountMedia(BUCKET, att.storage_path).catch(() => {});
  return true;
}
