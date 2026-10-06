"use client";

// ============================================================
// Doc Sign, signing page: agreeing to sign electronically. The wording is the server's (it is stored with
// the agreement together with its version), shown as it is. Nothing can be entered before this, and the
// document can be read first.
// ============================================================

import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { signerFileUrl } from "@/lib/sign/client/api";
import type { SigningView } from "@/lib/sign/service/signing";

import { DocumentIntro } from "./document-intro";
import { DocumentPages } from "./document-pages";
import { EnvelopeIntro } from "./envelope-bar";
import { useErrorText } from "./errors";
import type { ActionResult } from "./use-signer";

interface ConsentStepProps {
  token: string;
  view: SigningView;
  onAgree: () => Promise<ActionResult>;
  onDecline: () => void;
}

export function ConsentStep({ token, view, onAgree, onDecline }: ConsentStepProps) {
  const t = useTranslations("Sign.signer");
  // a form without a signature has no document to read first, and nothing to sign (migration 169)
  const formOnly = view.document.mode === "form";
  const errorText = useErrorText();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const checkId = useId();
  const messageId = useId();

  async function agree() {
    setBusy(true);
    setMessage(null);
    const result = await onAgree();
    // on success the page moves on and this screen goes with it
    setBusy(false);
    if (!result.ok && !result.handled) setMessage(errorText(result.error));
  }

  return (
    <div className="space-y-6">
      {view.envelope ? <EnvelopeIntro envelope={view.envelope} fill={view.document.mode === "form" && view.signer.kind === "filler"} /> : <DocumentIntro document={view.document} />}

      <section className="space-y-4 rounded-xl border bg-card p-4" aria-labelledby="consent-title">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("consent.before")}</p>
          <h2 id="consent-title" className="text-lg font-semibold">
            {formOnly ? t("consent.titleForm") : t("consent.title")}
          </h2>
        </div>
        <p className="whitespace-pre-line text-sm leading-relaxed">{view.consent.text}</p>
        <p className="text-xs text-muted-foreground">{t("consent.recorded")}</p>

        <div className="flex min-h-11 items-start gap-3">
          <input id={checkId} type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 size-6 shrink-0 accent-[var(--primary)]" />
          <label htmlFor={checkId} className="pt-0.5 text-base font-medium">
            {t("consent.agree")}
          </label>
        </div>

        {message ? (
          <p id={messageId} role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
            {message}
          </p>
        ) : null}

        <Button type="button" className="h-12 w-full text-base" disabled={!agreed || busy} aria-describedby={message ? messageId : undefined} onClick={() => void agree()}>
          {busy ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
          {t("common.continue")}
        </Button>
      </section>

      {/* a person handed one part of the form is not shown the document, and cannot end it */}
      {view.delegate ? null : (
        <div className="flex flex-col items-start gap-1">
          {formOnly ? null : (
            <button
              type="button"
              aria-expanded={reading}
              className="inline-flex min-h-11 items-center rounded-lg px-1 text-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() => setReading((r) => !r)}
            >
              {reading ? t("consent.hideDocument") : t("consent.readFirst")}
            </button>
          )}
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-lg px-1 text-sm text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={onDecline}
          >
            {formOnly ? t("fill.declineForm") : t("fill.decline")}
          </button>
        </div>
      )}

      {reading && !view.delegate && !formOnly ? <DocumentPages url={signerFileUrl(token)} /> : null}
    </div>
  );
}
