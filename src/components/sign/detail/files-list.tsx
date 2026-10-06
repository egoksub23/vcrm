"use client";

// Doc Sign, the detail screen: the files that belong to a document (the upload, its PDF, annexes, what the
// signers attached, the sealed copy).

import { useLocale, useTranslations } from "next-intl";
import { FileText } from "lucide-react";

import { formatSize } from "./format";
import type { DetailFile } from "./use-document-detail";

export function FilesList({ files }: { files: readonly DetailFile[] }) {
  const t = useTranslations("Sign.detail");
  const locale = useLocale();
  if (files.length === 0) return null;
  return (
    <section aria-labelledby="sign-files-title" className="grid gap-2">
      <h2 id="sign-files-title" className="text-sm font-semibold text-foreground">
        {t("files.title")}
      </h2>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {files.map((f) => (
          <li key={f.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 break-all text-foreground">{f.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {t(`files.kind.${f.kind}`)} · {formatSize(f.size_bytes, locale)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
