"use client";

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Editor } from "@tiptap/react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { KB_ATTACHMENT_MAX_BYTES, KB_MAX_ATTACHMENTS } from "@/lib/knowledge-types";
import { ImagePrepareError, prepareImageForUpload } from "@/lib/media/prepare-image";
import { deleteAccountMedia, uploadAccountMedia } from "@/lib/storage/upload-media";
import { updateImageByUploadId } from "@/lib/tiptap/inline-image";
import { formatBytes, type AttachmentRow } from "./kb-editor-utils";

/**
 * Puts pasted / dropped / chosen images into the article text.
 *
 * Each image appears in the text at once as a placeholder showing the local
 * picture (dimmed while it uploads) and is listed among the attachments as an
 * in-article file; the picture is shrunk (see `prepareImageForUpload`),
 * uploaded to the account's `kb/` folder, and the placeholder then points at
 * the public URL. A failure removes the placeholder and its row and says why.
 * If the person deletes the placeholder while it uploads, the upload is thrown
 * away when it lands.
 */
export function useKbInlineImages({
  editorRef,
  rowsRef,
  setRows,
  disabled,
}: {
  editorRef: MutableRefObject<Editor | null>;
  /** Always the latest rows (also updated here, ahead of the next render). */
  rowsRef: MutableRefObject<AttachmentRow[]>;
  setRows: Dispatch<SetStateAction<AttachmentRow[]>>;
  disabled: boolean;
}) {
  const t = useTranslations("Knowledge.editor");

  const patch = useCallback(
    (key: string, fields: Partial<AttachmentRow>) =>
      setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...fields } : r))),
    [setRows],
  );
  const drop = useCallback(
    (key: string) => {
      rowsRef.current = rowsRef.current.filter((r) => r.key !== key);
      setRows((prev) => prev.filter((r) => r.key !== key));
    },
    [rowsRef, setRows],
  );

  const explain = useCallback(
    (err: unknown): string => {
      if (err instanceof ImagePrepareError) {
        if (err.code === "unsupported") return t("imageUnsupported");
        if (err.code === "tooLarge") return t("imageTooLarge", { max: formatBytes(err.maxBytes ?? KB_ATTACHMENT_MAX_BYTES.image) });
        return t("imageUnreadable");
      }
      return err instanceof Error && err.message ? err.message : t("uploadFailed");
    },
    [t],
  );

  return useCallback(
    async (files: File[], pos?: number) => {
      const editor = editorRef.current;
      if (disabled || !editor || editor.isDestroyed || files.length === 0) return;

      const room = Math.max(0, KB_MAX_ATTACHMENTS - rowsRef.current.length);
      const accepted = files.slice(0, room);
      if (accepted.length < files.length) toast.error(t("attachTooMany", { max: KB_MAX_ATTACHMENTS }));
      if (accepted.length === 0) return;

      const items = accepted.map((file) => ({
        file,
        key: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        preview: URL.createObjectURL(file),
      }));

      // Placeholders in the text (at the drop point or the cursor) and rows in the list.
      const content = items.map((i) => ({ type: "image", attrs: { src: i.preview, alt: "", uploadId: i.key } }));
      if (pos !== undefined) editor.chain().insertContentAt(pos, content).run();
      else editor.chain().focus().insertContent(content).run();

      const added: AttachmentRow[] = items.map((i) => ({
        key: i.key,
        file_name: i.file.name || "image",
        mime_type: i.file.type || "image/png",
        size_bytes: i.file.size,
        url: "",
        storage_path: "",
        send_with_ai: true,
        status: "uploading",
        inline: true,
        caption: null,
        preview: i.preview,
      }));
      rowsRef.current = [...rowsRef.current, ...added];
      setRows((prev) => [...prev, ...added]);

      // One after the other, so the list keeps the order of the paste.
      for (const { file, key, preview } of items) {
        try {
          const prepared = await prepareImageForUpload(file, { maxBytes: KB_ATTACHMENT_MAX_BYTES.image });
          patch(key, { file_name: prepared.name, mime_type: prepared.type, size_bytes: prepared.size });
          const { publicUrl, path } = await uploadAccountMedia("chat-media", prepared, "kb");
          if (updateImageByUploadId(editor, key, { src: publicUrl })) {
            patch(key, { status: "ready", url: publicUrl, storage_path: path, preview: undefined });
          } else {
            // The image was deleted from the text while it uploaded.
            void deleteAccountMedia("chat-media", path).catch(() => {});
            drop(key);
          }
        } catch (err) {
          updateImageByUploadId(editor, key, null);
          drop(key);
          toast.error(explain(err));
        } finally {
          URL.revokeObjectURL(preview);
        }
      }
    },
    [disabled, editorRef, rowsRef, setRows, patch, drop, explain, t],
  );
}
