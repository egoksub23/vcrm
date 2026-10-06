"use client";

// ============================================================
// Doc Sign, signing page: the page for a person who opened their link. It shows the screen the document
// is at: the code, agreeing to sign, the document to fill in, or how it ended. The state and the calls are
// in use-signer; the logic that decides what to show is in src/lib/sign/client/signer-flow.ts.
// ============================================================

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import { pick } from "@/lib/sign/forms/text";
import type { SigningView } from "@/lib/sign/service/signing";

import { CodeStep } from "./code-step";
import { ConsentStep } from "./consent-step";
import { DeclineDialog } from "./decline-dialog";
import { DocumentStep } from "./document-step";
import { EndScreen, ForwardedScreen, InvalidLink } from "./end-screens";
import { EnvelopeBar, EnvelopeEnd } from "./envelope-bar";
import { useErrorText } from "./errors";
import { ForwardBar } from "./forward-bar";
import { ForwardDialog } from "./forward-dialog";
import { FormStep } from "./form/form-step";
import { SubmitReview } from "./form/submit-review";
import { Shell } from "./shell";
import { useSigner, type EnvelopeSitting } from "./use-signer";

interface SignerAppProps {
  /** The page's scope: the link's token, or `<token>@<document id>` for a document of an envelope (see lib/sign/client/scope.ts). */
  token: string;
  initialView: SigningView;
  initialSessionOk: boolean;
  locale: SignerLocale;
  onLocaleChange: (locale: SignerLocale) => void;
  product: string;
  /** Migration 171: this page is one document of an envelope's sitting (the wrapper that opens the documents gives how). */
  envelope?: EnvelopeSitting;
}

export function SignerApp({ token, initialView, initialSessionOk, locale, onLocaleChange, product, envelope }: SignerAppProps) {
  const t = useTranslations("Sign.signer");
  const tf = useTranslations("Sign.signerForm");
  const errorText = useErrorText();
  const signer = useSigner({ token, initialView, initialSessionOk, locale, envelope });
  const { view, screen, gone } = signer;
  const [declineOpen, setDeclineOpen] = useState(false);
  // forwarding (F-95): the dialog is open for the whole turn (`part` null) or for one part of the form
  const [forwardOpen, setForwardOpen] = useState<{ part: string | null } | null>(null);

  // When the screen changes (the form, its review, the document: all are "fill"), the new screen's heading is read out and the page starts at its top.
  const { form, formStage } = signer;
  const place = screen === "fill" ? `fill:${formStage}` : screen;
  const shown = useRef(place);
  useEffect(() => {
    if (shown.current === place) return;
    shown.current = place;
    const heading = document.querySelector<HTMLElement>("#sign-main h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    window.scrollTo({ top: 0 });
  }, [place]);

  // An envelope's person who finished a document (or opened one that is done) while others are still to do is taken to the next to do.
  const toDo = view.envelope?.state === "active" ? view.envelope.documents.find((d) => d.state === "active") : undefined;
  const elsewhere = !!envelope && !!toDo && toDo.id !== envelope.documentId && screen !== "code" && screen !== "consent" && screen !== "fill";
  useEffect(() => {
    if (elsewhere && toDo && envelope) envelope.go(toDo.id);
  }, [elsewhere, toDo, envelope]);

  const content = view.content;
  // a form without a signature (migration 169): nothing to read, nothing to sign; the parts, a review, Submit
  const formOnly = view.document.mode === "form";
  // a person handed one part of someone's form cannot end the document, so there is nothing for them to decline
  const canDecline = !gone && !view.delegate && (screen === "consent" || screen === "fill");
  const forwarding = !gone && (screen === "consent" || screen === "fill") ? (view.forwarding ?? null) : null;
  const delegations = Object.fromEntries((content?.delegations ?? []).map((d) => [d.part, { name: d.name, done: d.done }]));
  const forwardPartTitle = forwardOpen?.part ? pick(form?.definition.parts.find((p) => p.key === forwardOpen.part)?.title ?? { en: forwardOpen.part }, locale) || forwardOpen.part : null;

  let body: ReactNode;
  if (signer.forwarded) body = <ForwardedScreen to={signer.forwarded.to} delivered={signer.forwarded.delivered} />;
  else if (gone) body = <InvalidLink />;
  else if (screen === "code") body = <CodeStep title={view.envelope?.title ?? view.document.title} sessionExpired={signer.notice === "session_expired"} onSend={signer.sendCode} onVerify={signer.checkCode} />;
  else if (screen === "consent") body = <ConsentStep token={token} view={view} onAgree={signer.consent} onDecline={() => setDeclineOpen(true)} />;
  else if (screen === "fill") {
    body = content && form && formStage === "form" ? (
      <FormStep
        title={view.document.title}
        form={form}
        locale={locale}
        saveState={signer.saveState}
        rejected={signer.formRejected}
        notice={signer.formNotice}
        start={signer.formStart}
        filler={view.signer.kind === "filler"}
        formOnly={formOnly}
        onChange={signer.setFormAnswer}
        onUpload={signer.uploadFormFile}
        onRemoveUpload={signer.removeFormFile}
        onConfirmPart={signer.confirmFormPart}
        onFlush={signer.flush}
        onReview={() => void signer.openReview()}
        onSubmit={signer.finish}
        onDecline={view.delegate ? undefined : () => setDeclineOpen(true)}
        delegations={delegations}
        onForwardPart={forwarding?.canPart ? (part) => setForwardOpen({ part }) : undefined}
        onTakeBack={async (part) => {
          const result = await signer.takeBack(part);
          if (!result.ok) throw result.error;
        }}
      />
    ) : content && form && formOnly ? (
      signer.review.status === "ready" ? (
        <SubmitReview title={view.document.title} form={form} locale={locale} onBack={() => signer.openForm()} onEditPart={(part) => signer.openForm({ part })} onSubmit={signer.finish} />
      ) : signer.review.status === "error" ? (
        <div role="alert" className="flex flex-col items-center gap-3 py-16 text-center text-sm">
          <p className="font-medium">{tf("review.failedShort")}</p>
          <Button type="button" variant="outline" className="h-11" onClick={() => void signer.openReview()}>
            {tf("review.retry")}
          </Button>
        </div>
      ) : (
        <div role="status" className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-5 motion-safe:animate-spin" aria-hidden />
          {tf("review.preparingShort")}
        </div>
      )
    ) : content ? (
      <DocumentStep
        token={token}
        view={view}
        content={content}
        answers={signer.answers}
        rejected={signer.rejected}
        saveState={signer.saveState}
        onAnswer={signer.setAnswer}
        onFinish={signer.finish}
        onDecline={() => setDeclineOpen(true)}
        finishLabel={envelope ? t(signer.nextDocument ? "envelope.next" : "envelope.finish") : undefined}
        formReview={
          form && formStage === "review"
            ? { form, review: signer.review, onChangeAnswer: () => signer.openForm(), onOpenAnswer: (part, field) => signer.openForm({ part, field }), onRetry: () => void signer.openReview() }
            : undefined
        }
      />
    ) : (
      <div role="status" className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-5 motion-safe:animate-spin" aria-hidden />
        {t("fill.openingDocument")}
        <Button type="button" variant="outline" className="h-11" onClick={() => void signer.refresh()}>
          {t("common.tryAgain")}
        </Button>
      </div>
    );
  } else if (elsewhere) {
    body = (
      <div role="status" className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-5 motion-safe:animate-spin" aria-hidden />
        {t("fill.openingDocument")}
      </div>
    );
  } else if (view.envelope && (view.envelope.state === "signed" || view.envelope.state === "completed")) {
    // the person's sitting is over: every document of theirs is signed (or complete), as one page
    body = <EnvelopeEnd envelope={view.envelope} scope={token} name={view.signer.name} canDownload={signer.sessionOk || !view.document.codeRequired} />;
  } else {
    body = <EndScreen state={screen} view={view} token={token} canDownload={(signer.sessionOk || !view.document.codeRequired) && !view.delegate} />;
  }

  return (
    <>
      <Shell workspace={gone && !signer.forwarded ? null : view.workspace} locale={locale} onLocaleChange={onLocaleChange} product={product} test={view.document.test} wide={screen === "fill" && formStage !== "form" && !formOnly && !gone && !signer.forwarded} bottomSpace={screen === "fill" && formStage !== "form" && !formOnly && !gone && !signer.forwarded}>
        {signer.forwarded ? null : <ForwardBar from={view.forwardedFrom ?? null} delegate={!!view.delegate} canForward={!!forwarding?.canTurn} onForward={() => setForwardOpen({ part: null })} />}
        {envelope && view.envelope && screen === "fill" && !gone ? <EnvelopeBar envelope={view.envelope} onGo={(id) => { signer.flush(); envelope.go(id); }} /> : null}
        {body}
      </Shell>
      {forwarding && forwardOpen ? (
        <ForwardDialog
          open
          onOpenChange={(open) => !open && setForwardOpen(null)}
          part={forwardOpen.part ? { key: forwardOpen.part, title: forwardPartTitle ?? forwardOpen.part } : null}
          remaining={forwarding.remaining}
          onConfirm={async (values) => {
            const result = await signer.forward({ fullName: values.fullName, email: values.email, ...(values.note ? { note: values.note } : {}), ...(forwardOpen.part ? { part: forwardOpen.part } : {}) });
            if (result.ok || result.handled) {
              setForwardOpen(null);
              return null;
            }
            return errorText(result.error);
          }}
        />
      ) : null}
      {canDecline ? (
        <DeclineDialog
          open={declineOpen}
          onOpenChange={setDeclineOpen}
          formOnly={formOnly}
          envelopeCount={view.envelope?.count}
          onConfirm={async (reason) => {
            const result = await signer.decline(reason);
            if (result.ok || result.handled) {
              setDeclineOpen(false);
              return null;
            }
            return errorText(result.error);
          }}
        />
      ) : null}
    </>
  );
}
