"use client";

import { Loader2 } from "lucide-react";

/**
 * A picture pasted or dropped into the reply box, waiting above it to be sent:
 * a small thumbnail, "Pasted image", its size, and a remove button. While it
 * uploads it shows the local picture with a spinner and cannot be sent.
 */
export function PastedImageChip({
  src,
  label,
  sizeBytes,
  uploading,
  uploadingLabel,
  onRemove,
  removeLabel,
}: {
  src: string;
  label: string;
  sizeBytes: number;
  uploading: boolean;
  uploadingLabel: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted py-0.5 pl-0.5 pr-1.5 text-[11px] text-foreground"
      data-testid="pasted-image-chip"
      title={`${label} · ${formatSize(sizeBytes)}`}
    >
      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-card">
        {src ? (
          // A local or public-storage picture a few pixels wide: next/image adds nothing here.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className={uploading ? "h-full w-full object-cover opacity-50" : "h-full w-full object-cover"} />
        ) : null}
        {uploading ? <Loader2 className="absolute h-3.5 w-3.5 animate-spin text-foreground" aria-label={uploadingLabel} /> : null}
      </span>
      <span className="truncate">{uploading ? uploadingLabel : label}</span>
      {!uploading ? <span className="shrink-0 text-muted-foreground">{formatSize(sizeBytes)}</span> : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="-mr-0.5 shrink-0 rounded px-0.5 text-muted-foreground hover:text-foreground"
      >
        ×
      </button>
    </span>
  );
}

function formatSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
