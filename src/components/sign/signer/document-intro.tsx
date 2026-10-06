"use client";

// Doc Sign, signing page: what this document is. Its name, its reference, when the link stops working, and
// the sender's message to the person (plain text, kept as written).

import { useLocale, useTranslations } from "next-intl";

import type { SigningView } from "@/lib/sign/service/signing";

import { formatDay, useBrowserTimeZone } from "./dates";

export function DocumentIntro({ document, headingId }: { document: SigningView["document"]; headingId?: string }) {
  const t = useTranslations("Sign.signer");
  const locale = useLocale();
  const zone = useBrowserTimeZone();
  const expires = formatDay(document.expiresAt, locale, zone);

  return (
    <div className="space-y-2">
      <h1 id={headingId} className="break-words text-xl font-semibold leading-snug">
        {document.title}
      </h1>
      {document.reference || expires ? (
        <p className="text-sm text-muted-foreground">
          {document.reference ? t("doc.reference", { reference: document.reference }) : null}
          {document.reference && expires ? " · " : null}
          {expires ? t("doc.expires", { date: expires }) : null}
        </p>
      ) : null}
      {document.message ? (
        <figure className="rounded-lg border-l-4 border-primary bg-muted/50 px-3 py-2">
          <figcaption className="text-xs font-medium text-muted-foreground">{t("doc.messageFromSender")}</figcaption>
          <blockquote className="mt-1 whitespace-pre-wrap break-words text-sm">{document.message}</blockquote>
        </figure>
      ) : null}
    </div>
  );
}
