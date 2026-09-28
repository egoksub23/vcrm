import { createClient } from "@/lib/supabase/client";
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
export async function attachFileToIncident(
  incident: { id: string },
  file: File,
  userId: string,
  commentId?: string,
): Promise<IncidentAttachment> {
  const { publicUrl, path } = await uploadAccountMedia(BUCKET, file, SUBFOLDER);
  const { data, error } = await createClient()
    .from("incident_attachments")
    .insert({
      incident_id: incident.id,
      comment_id: commentId ?? null,
      storage_path: path,
      url: publicUrl,
      filename: file.name || "file",
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      uploaded_by: userId,
    })
    .select("*")
    .single();
  if (error || !data) {
    void deleteAccountMedia(BUCKET, path).catch(() => {});
    throw new Error(error?.message ?? "Could not save the attachment.");
  }
  return data as IncidentAttachment;
}

export async function removeIncidentAttachment(att: IncidentAttachment): Promise<boolean> {
  const { error } = await createClient().from("incident_attachments").delete().eq("id", att.id);
  if (error) return false;
  void deleteAccountMedia(BUCKET, att.storage_path).catch(() => {});
  return true;
}
