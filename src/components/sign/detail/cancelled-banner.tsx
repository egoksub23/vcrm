"use client";

// ============================================================
// Secure Sign, the detail screens: the notice at the top of a document (or a collection) that was CANCELLED after it was completed (migration 181).
// Who, when and why, and what it means: the signed copy and its certificate are kept as a record, unchanged, but it is no longer in force. The people and
// progress panels below are as they were. The colours are a pair for light and dark (light-dark()), and the word is the signal.
// ============================================================

import Link from "next/link";
import { Ban } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { formatWhen } from "./format";

interface Props {
  /** When it was cancelled. */
  at: string;
  /** Who cancelled it, by name; null when the person is no longer in the workspace. */
  by: string | null;
  /** What they wrote. */
  reason: string | null;
  /** A document that was cancelled with its collection says so, and links to it. */
  collection?: { id: string; reference: string | null; title: string } | null;
  /** The notice is about a whole collection. */
  isCollection?: boolean;
}

export function CancelledBanner({ at, by, reason, collection, isCollection }: Props) {
  const t = useTranslations("Sign.detail");
  const locale = useLocale();
  const when = formatWhen(at, locale);
  return (
    <section role="status" aria-labelledby="sign-cancelled-title" className="flex gap-3 rounded-xl border border-[color:light-dark(#fca5a5,#7f1d1d)] bg-[color:light-dark(#fef2f2,#450a0a66)] p-4">
      <Ban className="mt-0.5 size-5 shrink-0 text-[light-dark(#b91c1c,#fca5a5)]" aria-hidden />
      <div className="min-w-0">
        <h2 id="sign-cancelled-title" className="font-medium text-foreground break-words">
          {t(isCollection ? "cancelledBanner.titleCollection" : "cancelledBanner.title")}
        </h2>
        <p className="mt-0.5 text-sm text-foreground break-words">{by ? t("cancelledBanner.byOn", { name: by, date: when }) : t("cancelledBanner.on", { date: when })}</p>
        {reason ? <p className="mt-1 text-sm text-foreground break-words">{t("cancelledBanner.reason", { reason })}</p> : null}
        <p className="mt-1 text-sm text-muted-foreground break-words">{t(isCollection ? "cancelledBanner.noteCollection" : "cancelledBanner.note")}</p>
        {collection ? (
          <p className="mt-1 text-sm text-muted-foreground break-words">
            {t("cancelledBanner.withCollection")}{" "}
            <Link href={`/sign/envelopes/${collection.id}`} className="text-primary hover:underline">
              {[collection.title, collection.reference].filter(Boolean).join(" · ")}
            </Link>
          </p>
        ) : null}
      </div>
    </section>
  );
}
