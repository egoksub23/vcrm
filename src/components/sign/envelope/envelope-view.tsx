"use client";

import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { useSignEnvelope } from "@/hooks/use-sign-envelope";
import { errorKey } from "@/lib/sign/client/errors";

import { EnvelopeDetail } from "./envelope-detail";
import { EnvelopeDraft } from "./envelope-draft";

/**
 * One envelope: its page is the draft screen (the documents, one signing list, the options, the review) while it is a draft, and the envelope's
 * own detail (what is happening to it, its documents, its people) from the moment it is sent.
 */
export function EnvelopeView({ envelopeId }: { envelopeId: string }) {
  const t = useTranslations("Sign.send.envelope.view");
  const tErr = useTranslations("Sign.send");
  const { data, error, loading, reload } = useSignEnvelope(envelopeId);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24" role="status" aria-label={t("loading")}>
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div role="alert" className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center">
        <AlertCircle className="size-6 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold text-foreground">{error?.code === "envelope_not_found" ? t("notFoundTitle") : t("failedTitle")}</h1>
        <p className="text-sm text-muted-foreground">{tErr(errorKey(error?.code))}</p>
        <div className="flex gap-2">
          {error?.code !== "envelope_not_found" ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
              {t("retry")}
            </Button>
          ) : null}
          <Link href="/sign" className="inline-flex h-7 items-center rounded-lg px-2.5 text-[0.8rem] font-medium text-primary hover:underline">
            {t("backToDocuments")}
          </Link>
        </div>
      </div>
    );
  }

  if (data.envelope.status === "draft") {
    return <EnvelopeDraft key={envelopeId} envelopeId={envelopeId} data={data} reload={reload} onOpen={() => void reload()} />;
  }
  return <EnvelopeDetail data={data} reload={reload} />;
}
