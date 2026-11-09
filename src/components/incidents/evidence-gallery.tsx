"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, Trash2 } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSignedMediaUrl } from "@/hooks/use-signed-media-url";
import type { IncidentAttachment } from "@/lib/incidents/types";

/** Pictures show as pictures; everything else stays a file row. Decided by the type the browser reported, or the file name when it reported none. */
export function isPicture(a: Pick<IncidentAttachment, "mime_type" | "filename">): boolean {
  return a.mime_type.startsWith("image/") || /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(a.filename);
}

/**
 * A delete button that asks once before it deletes: click the bin, then "Yes, delete" or "Keep". Deleting a file cannot be undone.
 */
export function DeleteButton({ onDelete, label }: { onDelete: () => Promise<void>; label: string }) {
  const t = useTranslations("Incidents.detail");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!asking) {
    return (
      <button type="button" onClick={() => setAsking(true)} aria-label={label} title={label} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive">
        <Trash2 className="size-3.5" />
      </button>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11.5px]">
      <span className="text-muted-foreground">{t("deleteConfirm")}</span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onDelete();
          setBusy(false);
          setAsking(false);
        }}
        className="inline-flex items-center gap-1 rounded bg-destructive px-1.5 py-0.5 font-medium text-white hover:opacity-90 disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : null}
        {t("deleteYes")}
      </button>
      <button type="button" disabled={busy} onClick={() => setAsking(false)} className="rounded px-1.5 py-0.5 font-medium text-muted-foreground hover:bg-muted">
        {t("deleteNo")}
      </button>
    </span>
  );
}

function Thumb({ attachment: a, onOpen }: { attachment: IncidentAttachment; onOpen: () => void }) {
  const { src } = useSignedMediaUrl(a.url);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={a.filename}
      aria-label={a.filename}
      className="aspect-square overflow-hidden rounded-lg border border-border bg-muted outline-none hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- a signed storage URL, not a static asset
        <img src={src} alt={a.filename} loading="lazy" className="size-full object-cover" />
      ) : null}
    </button>
  );
}

function Big({ attachment: a }: { attachment: IncidentAttachment }) {
  const { src } = useSignedMediaUrl(a.url);
  if (!src) return <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">…</div>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a signed storage URL, not a static asset
    <img src={src} alt={a.filename} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-md object-contain" />
  );
}

/**
 * The pictures kept with an incident, as small squares. Click one to see it large; the arrow keys (or the buttons) move to the next and the previous.
 */
export function EvidenceGallery({ pictures, canDelete, onDelete }: { pictures: IncidentAttachment[]; canDelete?: (a: IncidentAttachment) => boolean; onDelete?: (a: IncidentAttachment) => Promise<void> }) {
  const t = useTranslations("Incidents.detail");
  const [at, setAt] = useState<number | null>(null);
  const count = pictures.length;

  const step = useCallback(
    (by: number) => setAt((cur) => (cur === null || count === 0 ? cur : (cur + by + count) % count)),
    [count],
  );

  useEffect(() => {
    if (at === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, step]);

  if (count === 0) return null;
  const open = at !== null ? pictures[Math.min(at, count - 1)] : null;

  return (
    <>
      <ul className="grid grid-cols-3 gap-1.5" aria-label={t("evidenceTitle")}>
        {pictures.map((p, n) => (
          <li key={p.id}>
            <Thumb attachment={p} onOpen={() => setAt(n)} />
          </li>
        ))}
      </ul>

      <Dialog open={open !== null} onOpenChange={(o) => !o && setAt(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
          {open ? (
            <>
              <DialogHeader>
                <DialogTitle className="truncate pr-6 text-base">{open.filename}</DialogTitle>
                <DialogDescription>
                  {format(new Date(open.created_at), "d MMM yyyy, HH:mm")} · {t("pictureOf", { n: (at ?? 0) + 1, total: count })}
                </DialogDescription>
              </DialogHeader>
              <div className="relative">
                <Big attachment={open} />
                {count > 1 ? (
                  <>
                    <button type="button" onClick={() => step(-1)} aria-label={t("picturePrev")} className="absolute top-1/2 left-1 -translate-y-1/2 rounded-full bg-background/80 p-2 shadow hover:bg-background">
                      <ChevronLeft className="size-5" />
                    </button>
                    <button type="button" onClick={() => step(1)} aria-label={t("pictureNext")} className="absolute top-1/2 right-1 -translate-y-1/2 rounded-full bg-background/80 p-2 shadow hover:bg-background">
                      <ChevronRight className="size-5" />
                    </button>
                  </>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <OpenOriginal attachment={open} label={t("pictureOpen")} />
                {onDelete && canDelete?.(open) ? (
                  <DeleteButton
                    label={t("deleteFile")}
                    onDelete={async () => {
                      await onDelete(open);
                      // the picture is gone: show the next one, or close when it was the last
                      setAt((cur) => (cur === null || count <= 1 ? null : Math.min(cur, count - 2)));
                    }}
                  />
                ) : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function OpenOriginal({ attachment: a, label }: { attachment: IncidentAttachment; label: string }) {
  const { src } = useSignedMediaUrl(a.url);
  if (!src) return null;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-xs font-medium text-primary hover:underline">
      <ExternalLink className="size-3.5" />
      {label}
    </a>
  );
}
