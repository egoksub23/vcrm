"use client";

import { useRef, useState } from "react";
import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Loader2,
  Paperclip,
  Presentation,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { KB_MAX_ATTACHMENTS } from "@/lib/knowledge-types";
import { deleteAccountMedia, uploadAccountMedia } from "@/lib/storage/upload-media";
import { Switch } from "@/components/ui/switch";
import {
  checkAttachmentFile,
  fileVisual,
  formatBytes,
  unsavedUploads,
  type AttachmentRow,
  type FileVisual,
} from "./kb-editor-utils";

const ICONS: Record<Exclude<FileVisual, "image">, { Icon: typeof FileIcon; tone: string }> = {
  pdf: { Icon: FileText, tone: "text-red-600 bg-red-500/10" },
  word: { Icon: FileText, tone: "text-blue-600 bg-blue-500/10" },
  slides: { Icon: Presentation, tone: "text-orange-600 bg-orange-500/10" },
  sheet: { Icon: FileSpreadsheet, tone: "text-green-600 bg-green-500/10" },
  video: { Icon: FileVideo, tone: "text-purple-600 bg-purple-500/10" },
  audio: { Icon: FileAudio, tone: "text-purple-600 bg-purple-500/10" },
  archive: { Icon: FileArchive, tone: "text-amber-600 bg-amber-500/10" },
  text: { Icon: FileText, tone: "text-muted-foreground bg-muted" },
  other: { Icon: FileIcon, tone: "text-muted-foreground bg-muted" },
};

function Thumb({ row }: { row: AttachmentRow }) {
  const visual = fileVisual(row.mime_type, row.file_name);
  if (visual === "image" && row.url) {
    return (
      // A small preview of a public storage URL: next/image adds nothing here.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={row.url} alt="" className="h-10 w-10 shrink-0 rounded-md border border-border object-cover" />
    );
  }
  const { Icon, tone } = ICONS[visual === "image" ? "other" : visual];
  return (
    <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-md", tone)}>
      <Icon className="h-5 w-5" />
    </span>
  );
}

/**
 * Files that travel with an article: an agent inserting it, or the AI
 * answering from it, sends them along with the text. Any file type. A file
 * uploads the moment it is added (so the save request stays small) into the
 * account's `kb/` folder, and an upload that was never saved is deleted again
 * when it is removed. The parent owns the list because it needs it to save
 * and to clean up when the editor is abandoned.
 */
export function KbAttachments({
  rows,
  onChange,
  disabled,
}: {
  rows: AttachmentRow[];
  onChange: (update: (prev: AttachmentRow[]) => AttachmentRow[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("Knowledge.editor");
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const patch = (key: string, fields: Partial<AttachmentRow>) =>
    onChange((prev) => prev.map((r) => (r.key === key ? { ...r, ...fields } : r)));

  async function addFiles(files: File[]) {
    if (disabled || files.length === 0) return;
    let count = rows.length;
    for (const file of files) {
      const rejection = checkAttachmentFile(file, count);
      if (rejection) {
        toast.error(
          rejection.reason === "tooMany"
            ? t("attachTooMany", { max: rejection.max })
            : t("attachTooLarge", { name: file.name, max: formatBytes(rejection.maxBytes) }),
        );
        if (rejection.reason === "tooMany") break;
        continue;
      }
      count += 1;
      const key = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const base: AttachmentRow = {
        key,
        file_name: file.name,
        mime_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        url: "",
        storage_path: "",
        send_with_ai: true,
        status: "uploading",
      };
      onChange((prev) => [...prev, base]);
      // Sequential on purpose: keeps the list order the same as the drop
      // order and avoids hammering the bucket with ten parallel uploads.
      try {
        const { publicUrl, path } = await uploadAccountMedia("chat-media", file, "kb");
        patch(key, { status: "ready", url: publicUrl, storage_path: path });
      } catch (err) {
        patch(key, { status: "error", error: err instanceof Error ? err.message : t("uploadFailed") });
      }
    }
  }

  function remove(row: AttachmentRow) {
    onChange((prev) => prev.filter((r) => r.key !== row.key));
    // A file nobody saved would otherwise sit in the public bucket forever.
    for (const u of unsavedUploads([row])) void deleteAccountMedia("chat-media", u.storage_path).catch(() => {});
  }

  const full = rows.length >= KB_MAX_ATTACHMENTS;

  return (
    <section className="space-y-2" aria-label={t("attachments")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Paperclip className="h-4 w-4 text-muted-foreground" />
          {t("attachments")}
          <span className="text-xs font-normal text-muted-foreground">
            {rows.length}/{KB_MAX_ATTACHMENTS}
          </span>
        </h3>
      </div>
      <p className="text-xs text-muted-foreground">{t("attachmentsHint")}</p>

      <div
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(Array.from(e.dataTransfer.files));
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-4 py-5 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border",
          (disabled || full) && "opacity-60",
        )}
      >
        <Upload className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm text-foreground">{t("dropFiles")}</p>
        <button
          type="button"
          disabled={disabled || full}
          onClick={() => inputRef.current?.click()}
          className="text-sm font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:no-underline"
        >
          {t("addFiles")}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          data-testid="kb-file-input"
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []));
            // Let the same file be picked again after removing it.
            e.target.value = "";
          }}
        />
      </div>

      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.key} className="flex items-center gap-3 rounded-lg border border-border p-2">
              <Thumb row={row} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground" title={row.file_name}>
                  {row.file_name}
                </p>
                {row.status === "uploading" ? (
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> {t("uploading")}
                  </p>
                ) : row.status === "error" ? (
                  <p className="truncate text-xs text-destructive" title={row.error}>
                    {row.error ?? t("uploadFailed")}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">{formatBytes(row.size_bytes)}</p>
                )}
              </div>
              {row.status === "ready" && (
                <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="hidden sm:inline">{t("sendWithAi")}</span>
                  <Switch
                    checked={row.send_with_ai}
                    onCheckedChange={(v) => patch(row.key, { send_with_ai: v })}
                    disabled={disabled}
                    aria-label={t("sendWithAiFor", { name: row.file_name })}
                  />
                </label>
              )}
              <button
                type="button"
                aria-label={t("removeFile", { name: row.file_name })}
                title={t("remove")}
                disabled={disabled || row.status === "uploading"}
                onClick={() => remove(row)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
