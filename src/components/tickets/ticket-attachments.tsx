"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FileText, Loader2, Paperclip, Trash2, Upload } from "lucide-react";

import { cn } from "@/lib/utils";
import { TICKET_MAX_ATTACHMENTS, formatBytes, splitAttachments } from "@/lib/tickets/attachments";
import { dragHasFiles } from "@/lib/media/clipboard-images";
import type { UploadingFile } from "@/hooks/use-ticket-detail";
import type { TicketAttachment } from "@/types";

/**
 * The ticket's files: picture thumbnails, then file chips. Add by dragging
 * files here, pasting a picture anywhere in the ticket (handled by the
 * parent), or the button. You can remove what you uploaded (an admin can
 * remove any).
 */
export function TicketAttachmentsSection({
  attachments,
  uploading,
  canWork,
  canRemove,
  onAddFiles,
  onRemove,
}: {
  attachments: TicketAttachment[];
  uploading: UploadingFile[];
  canWork: boolean;
  canRemove: (attachment: TicketAttachment) => boolean;
  onAddFiles: (files: File[]) => void;
  onRemove: (attachment: TicketAttachment) => void;
}) {
  const t = useTranslations("Tickets.attachments");
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { images, files } = splitAttachments(attachments);
  const full = attachments.length + uploading.length >= TICKET_MAX_ATTACHMENTS;

  const removeButton = (a: TicketAttachment, className: string) =>
    canRemove(a) ? (
      <button
        type="button"
        onClick={() => onRemove(a)}
        aria-label={t("remove", { name: a.filename })}
        title={t("remove", { name: a.filename })}
        className={className}
      >
        <Trash2 className="size-3.5" />
      </button>
    ) : null;

  return (
    <section
      aria-label={t("title")}
      className="space-y-2"
      onDragOver={(e) => {
        if (!canWork || !dragHasFiles(e.dataTransfer.types)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!canWork || !dragHasFiles(e.dataTransfer.types)) return;
        e.preventDefault();
        setDragging(false);
        onAddFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <Paperclip className="size-3.5 text-muted-foreground" />
          {t("title")}
          {attachments.length > 0 ? (
            <span className="text-xs font-normal text-muted-foreground">{attachments.length}</span>
          ) : null}
        </h3>
        {canWork ? (
          <>
            <button
              type="button"
              disabled={full}
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Upload className="size-3.5" />
              {t("add")}
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              data-testid="ticket-file-input"
              onChange={(e) => {
                onAddFiles(Array.from(e.target.files ?? []));
                // Let the same file be picked again after removing it.
                e.target.value = "";
              }}
            />
          </>
        ) : null}
      </div>

      {attachments.length === 0 && uploading.length === 0 ? (
        <div
          className={cn(
            "rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-border",
          )}
        >
          {canWork ? t("empty") : t("emptyReadOnly")}
        </div>
      ) : (
        <div className={cn("space-y-2 rounded-lg transition-colors", dragging && "bg-primary/5 ring-1 ring-primary")}>
          {images.length > 0 || uploading.length > 0 ? (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {images.map((a) => (
                <li key={a.id} className="group relative overflow-hidden rounded-md border border-border bg-muted">
                  <a href={a.url} target="_blank" rel="noreferrer" title={a.filename} className="block aspect-square">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.url} alt={a.filename} loading="lazy" className="size-full object-cover" />
                  </a>
                  {removeButton(
                    a,
                    "absolute top-1 right-1 rounded bg-background/90 p-1 text-muted-foreground opacity-0 shadow-sm group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100",
                  )}
                </li>
              ))}
              {uploading.map((u) => (
                <li
                  key={u.key}
                  className="flex aspect-square items-center justify-center rounded-md border border-dashed border-border text-muted-foreground"
                  title={u.name}
                >
                  <Loader2 className="size-4 animate-spin" />
                </li>
              ))}
            </ul>
          ) : null}
          {files.length > 0 ? (
            <ul className="space-y-1">
              {files.map((a) => (
                <li key={a.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[13px]">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <a href={a.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:underline" title={a.filename}>
                    {a.filename}
                  </a>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(a.size_bytes)}</span>
                  {removeButton(a, "shrink-0 rounded p-1 text-muted-foreground hover:text-destructive")}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </section>
  );
}
