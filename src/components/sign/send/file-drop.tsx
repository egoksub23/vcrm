"use client";

import { useRef, useState } from "react";
import { FileText, UploadCloud, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { MAX_UPLOAD_MB, UPLOAD_ACCEPT, formatBytes } from "@/lib/sign/client/upload";
import { cn } from "@/lib/utils";

interface Props {
  file: File | null;
  onFile: (file: File | null) => void;
  disabled?: boolean;
}

/** Drop a file or choose one. Shows what is accepted and the size limit, and the chosen file with a way to remove it. */
export function FileDrop({ file, onFile, disabled }: Props) {
  const t = useTranslations("Sign.send.new");
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  if (file) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
        <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
          <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeFile")} disabled={disabled} onClick={() => onFile(null)}>
          <X />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
        over ? "border-primary bg-primary/5" : "border-border",
        disabled && "opacity-60",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const dropped = e.dataTransfer.files?.[0];
        if (dropped && !disabled) onFile(dropped);
      }}
    >
      <UploadCloud className="size-7 text-muted-foreground" aria-hidden />
      <p className="text-sm text-foreground">
        {t("dropHere")}{" "}
        <button
          type="button"
          disabled={disabled}
          className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
          onClick={() => input.current?.click()}
        >
          {t("chooseFile")}
        </button>
      </p>
      <p className="text-xs text-muted-foreground">{t("fileTypes", { max: MAX_UPLOAD_MB })}</p>
      <input
        ref={input}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label={t("chooseFile")}
        disabled={disabled}
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          if (chosen) onFile(chosen);
          e.target.value = "";
        }}
      />
    </div>
  );
}
