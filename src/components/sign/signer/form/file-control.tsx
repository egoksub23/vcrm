"use client";

// ============================================================
// Doc Sign, signing page, forms in parts: the two controls that take a file: a document for a checklist
// (PDF, JPG or PNG: choose one, or take a photo on a phone) and a picture (the company stamp). A file is
// checked here for its type and size before it is sent, and again by the server by what it really is;
// either way the person is told in words what to do. What is already uploaded is listed with its name,
// its size and a way to remove it.
// ============================================================

import { useId, useRef, useState } from "react";
import { Camera, FileText, Loader2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  KIND_LABEL,
  acceptAttribute,
  acceptedKinds,
  acceptsPictures,
  fileProblem,
  formatBytes,
  maxFileCount,
  maxFileMb,
  uploadFailure,
  type FormRejection,
} from "@/lib/sign/client/signer-form";
import type { DataField, FileSummary } from "@/lib/sign/forms/types";

import { fileToImageDataUrl } from "../image-utils";
import { type ControlProps } from "./control-props";
import { useFormText, useProblemText } from "./form-ui";

export interface FileControlProps {
  field: DataField;
  id: string;
  describedBy?: string;
  files: FileSummary[];
  /** Not given in a preview: nothing is uploaded. */
  onUpload?: (key: string, file: File, onProgress?: (fraction: number) => void) => Promise<void>;
  onRemoveUpload?: (key: string, fileId: string) => Promise<void>;
}

interface InFlight {
  id: number;
  name: string;
  fraction: number | null;
}

let counter = 0;

/** A file picker button that looks like a button and works from the keyboard. */
function PickButton({ id, accept, capture, disabled, children, onFiles, multiple, describedBy }: { id: string; accept: string; capture?: "environment"; disabled?: boolean; children: React.ReactNode; onFiles: (files: File[]) => void; multiple?: boolean; describedBy?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        id={id}
        type="file"
        accept={accept}
        capture={capture}
        multiple={multiple}
        tabIndex={-1}
        aria-describedby={describedBy}
        className="sr-only"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          // the same file may be chosen again after a failure
          e.target.value = "";
          if (list.length > 0) onFiles(list);
        }}
      />
      <Button type="button" variant="outline" className="h-11 flex-1 px-3 text-base sm:flex-none" disabled={disabled} onClick={() => ref.current?.click()}>
        {children}
      </Button>
    </>
  );
}

export function FileControl({ field, id, describedBy, files, onUpload, onRemoveUpload }: FileControlProps) {
  const t = useTranslations("Sign.signerForm");
  const problemText = useProblemText();
  const [flight, setFlight] = useState<InFlight[]>([]);
  const [failure, setFailure] = useState<FormRejection | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const errorId = useId();

  const max = maxFileCount(field);
  const mb = maxFileMb(field);
  const kinds = acceptedKinds(field).map((k) => KIND_LABEL[k]);
  const accept = acceptAttribute(field);
  const full = files.length + flight.length >= max;

  async function addAll(list: File[]) {
    setFailure(null);
    let count = files.length + flight.length;
    for (const file of list) {
      const problem = fileProblem(field, file, count);
      if (problem) {
        setFailure(problem);
        break;
      }
      if (!onUpload) {
        setFailure({ code: "upload_failed" });
        break;
      }
      count += 1;
      const item: InFlight = { id: ++counter, name: file.name, fraction: null };
      setFlight((cur) => [...cur, item]);
      try {
        await onUpload(field.key, file, (fraction) => setFlight((cur) => cur.map((x) => (x.id === item.id ? { ...x, fraction } : x))));
      } catch (err) {
        setFailure(uploadFailure(field, err as { code?: string }));
        break;
      } finally {
        setFlight((cur) => cur.filter((x) => x.id !== item.id));
      }
    }
  }

  async function remove(file: FileSummary) {
    if (!onRemoveUpload) return;
    setFailure(null);
    setRemoving(file.id);
    try {
      await onRemoveUpload(field.key, file.id);
    } catch (err) {
      setFailure(uploadFailure(field, err as { code?: string }));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="space-y-3">
      {files.length > 0 || flight.length > 0 ? (
        <ul className="space-y-2">
          {files.map((file) => (
            <li key={file.id} className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2">
              <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
              </div>
              <Button type="button" variant="outline" className="h-11 shrink-0 px-3 text-sm" disabled={removing === file.id || !onRemoveUpload} aria-label={t("file.removeNamed", { name: file.name })} onClick={() => void remove(file)}>
                {removing === file.id ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
                {t("file.remove")}
              </Button>
            </li>
          ))}
          {flight.map((item) => (
            <li key={item.id} className="rounded-lg border border-dashed bg-background px-3 py-2" role="status">
              <div className="flex items-center gap-3">
                <Loader2 className="size-5 shrink-0 text-muted-foreground motion-safe:animate-spin" aria-hidden />
                <p className="min-w-0 flex-1 break-words text-sm font-medium">{t("file.uploading", { name: item.name })}</p>
                {item.fraction !== null ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{Math.round(item.fraction * 100)}%</span> : null}
              </div>
              <progress className="mt-2 h-1.5 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary" max={1} value={item.fraction ?? undefined} aria-label={t("file.uploading", { name: item.name })} />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <PickButton id={id} accept={accept} multiple={max - files.length - flight.length > 1} disabled={full || !onUpload} describedBy={describedBy} onFiles={(list) => void addAll(list.slice(0, Math.max(1, max - files.length - flight.length)))}>
          <Upload className="size-4" aria-hidden />
          {files.length > 0 ? t("file.addAnother") : t("file.choose")}
        </PickButton>
        {acceptsPictures(field) ? (
          // only a phone has a camera to open; elsewhere this is the same as choosing a file
          <span className="hidden pointer-coarse:contents">
            <PickButton id={`${id}-camera`} accept="image/*" capture="environment" disabled={full || !onUpload} onFiles={(list) => void addAll(list.slice(0, 1))}>
              <Camera className="size-4" aria-hidden />
              {t("file.takePhoto")}
            </PickButton>
          </span>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        {t("file.hint", { types: kinds.join(", "), mb })} {t("file.count", { count: files.length, max })}
      </p>
      {failure ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-destructive">
          {problemText(failure)}
        </p>
      ) : null}
    </div>
  );
}

/** The company stamp, or any picture the form asks for: chosen or taken, made small enough, shown back. */
export function ImageControl({ field, id, input, describedBy, onInput }: ControlProps) {
  const t = useTranslations("Sign.signerForm");
  const text = useFormText();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"pictureTooBig" | "pictureUnreadable" | null>(null);
  const picture = typeof input.image === "string" && input.image ? input.image : null;

  async function choose(files: File[]) {
    const file = files[0];
    if (!file) return;
    setBusy(true);
    setProblem(null);
    const result = await fileToImageDataUrl(file, "picture");
    setBusy(false);
    if (result.ok) onInput({ image: result.dataUrl });
    else setProblem(result.reason === "too_big" ? "pictureTooBig" : "pictureUnreadable");
  }

  return (
    <div className="space-y-3">
      {picture ? (
        // the picture the person gave, on white, as it will be printed
        <div className="flex h-40 items-center justify-center rounded-xl border bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={picture} alt={t("image.alt", { label: text(field.label) })} className="max-h-full max-w-full object-contain" draggable={false} />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <PickButton id={id} accept="image/*" disabled={busy} describedBy={describedBy} onFiles={(files) => void choose(files)}>
          <Upload className="size-4" aria-hidden />
          {picture ? t("image.chooseAnother") : t("image.choose")}
        </PickButton>
        <span className="hidden pointer-coarse:contents">
          <PickButton id={`${id}-camera`} accept="image/*" capture="environment" disabled={busy} onFiles={(files) => void choose(files)}>
            <Camera className="size-4" aria-hidden />
            {t("file.takePhoto")}
          </PickButton>
        </span>
        {picture ? (
          <Button type="button" variant="outline" className="h-11 flex-1 px-3 text-base sm:flex-none" onClick={() => onInput({ image: "" })}>
            {t("image.remove")}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {busy ? t("image.preparing") : t("image.hint")}
      </p>
      {problem ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t(`image.${problem}`)}
        </p>
      ) : null}
    </div>
  );
}
