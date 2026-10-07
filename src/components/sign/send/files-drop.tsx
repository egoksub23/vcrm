"use client";

import { useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import { useTranslations } from "next-intl";

import { MAX_UPLOAD_MB, UPLOAD_ACCEPT } from "@/lib/sign/client/upload";
import { cn } from "@/lib/utils";

interface Props {
  /** Every file chosen or dropped, in the order they came (one call for the whole choice, so a few files at once are one step). */
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  /** How many more documents fit; at none the zone says so and takes nothing. */
  room?: number;
}

/** Drop several files or choose several (a multi-file chooser). The sender can come back and add more, one at a time or many. */
export function FilesDrop({ onFiles, disabled, room }: Props) {
  const t = useTranslations("Sign.send.collection.files");
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const full = room !== undefined && room <= 0;
  const off = disabled || full;

  return (
    <div
      className={cn("flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors", over ? "border-primary bg-primary/5" : "border-border", off && "opacity-60")}
      onDragOver={(e) => {
        e.preventDefault();
        if (!off) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const dropped = Array.from(e.dataTransfer.files ?? []);
        if (dropped.length > 0 && !off) onFiles(dropped);
      }}
    >
      <UploadCloud className="size-7 text-muted-foreground" aria-hidden />
      <p className="text-sm text-foreground">
        {t("dropHere")}{" "}
        <button type="button" disabled={off} className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline" onClick={() => input.current?.click()}>
          {t("chooseFiles")}
        </button>
      </p>
      <p className="text-xs text-muted-foreground">{t("hint", { max: MAX_UPLOAD_MB })}</p>
      <input
        ref={input}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label={t("inputLabel")}
        disabled={off}
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? []);
          if (chosen.length > 0) onFiles(chosen);
          e.target.value = "";
        }}
      />
    </div>
  );
}
