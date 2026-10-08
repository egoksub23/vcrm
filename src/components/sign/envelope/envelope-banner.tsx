"use client";

// ============================================================
// Doc Sign, a document's own page (migration 171): this document is one of an envelope. It says which, lists the others (their titles and states
// only) and takes the sender to the envelope, where remind, resend, change recipient, expiry and cancel are done for the whole envelope (a single
// document of an envelope is never cancelled or reminded on its own).
// ============================================================

import Link from "next/link";
import { Layers } from "lucide-react";
import { useTranslations } from "next-intl";

import type { EnvelopeBrief } from "@/lib/sign/service/envelopes";
import { cn } from "@/lib/utils";

import { DocumentStatusBadge } from "../send/status-badge";

export function EnvelopeBanner({ envelope, documentId }: { envelope: EnvelopeBrief; documentId: string }) {
  const t = useTranslations("Sign.send.envelope.banner");
  const place = envelope.documents.find((d) => d.id === documentId)?.position ?? 1;
  return (
    <section aria-labelledby="doc-envelope" className="grid gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <Layers className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <h2 id="doc-envelope" className="text-sm font-semibold text-foreground">
              {t("title", { number: place, count: envelope.documents.length })}
            </h2>
            <p className="break-words text-sm text-muted-foreground">{[envelope.title, envelope.reference].filter(Boolean).join(" · ")}</p>
          </div>
        </div>
        <Link href={`/sign/envelopes/${envelope.id}`} className="inline-flex h-7 items-center rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium hover:bg-muted">
          {t("open")}
        </Link>
      </div>
      <ol className="grid gap-1.5 sm:grid-cols-2">
        {envelope.documents.map((d) => {
          const here = d.id === documentId;
          return (
            <li key={d.id} className={cn("flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-sm", here ? "border-primary bg-background font-medium" : "border-border bg-background/60")}>
              {here ? (
                <span className="min-w-0 truncate" aria-current="page">
                  {d.position}. {d.title}
                </span>
              ) : (
                <Link href={`/sign/${d.id}`} className="min-w-0 truncate text-foreground hover:underline">
                  {d.position}. {d.title}
                </Link>
              )}
              <DocumentStatusBadge status={d.status} cancelled={!!envelope.cancelledAt} />
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">{t("manageNote")}</p>
    </section>
  );
}
