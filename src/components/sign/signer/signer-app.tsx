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
import type { SigningView } from "@/lib/sign/service/signing";

import { CodeStep } from "./code-step";
import { ConsentStep } from "./consent-step";
import { DeclineDialog } from "./decline-dialog";
import { DocumentStep } from "./document-step";
import { EndScreen, InvalidLink } from "./end-screens";
import { useErrorText } from "./errors";
import { Shell } from "./shell";
import { useSigner } from "./use-signer";

interface SignerAppProps {
  token: string;
  initialView: SigningView;
  initialSessionOk: boolean;
  locale: SignerLocale;
  onLocaleChange: (locale: SignerLocale) => void;
  product: string;
}

export function SignerApp({ token, initialView, initialSessionOk, locale, onLocaleChange, product }: SignerAppProps) {
  const t = useTranslations("Sign.signer");
  const errorText = useErrorText();
  const signer = useSigner({ token, initialView, initialSessionOk, locale });
  const { view, screen, gone } = signer;
  const [declineOpen, setDeclineOpen] = useState(false);

  // When the screen changes, the new screen's heading is read out and the page starts at its top.
  const shown = useRef(screen);
  useEffect(() => {
    if (shown.current === screen) return;
    shown.current = screen;
    const heading = document.querySelector<HTMLElement>("#sign-main h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    window.scrollTo({ top: 0 });
  }, [screen]);

  const content = view.content;
  const canDecline = !gone && (screen === "consent" || screen === "fill");

  let body: ReactNode;
  if (gone) body = <InvalidLink />;
  else if (screen === "code") body = <CodeStep title={view.document.title} sessionExpired={signer.notice === "session_expired"} onSend={signer.sendCode} onVerify={signer.checkCode} />;
  else if (screen === "consent") body = <ConsentStep token={token} view={view} onAgree={signer.consent} onDecline={() => setDeclineOpen(true)} />;
  else if (screen === "fill") {
    body = content ? (
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
  } else {
    body = <EndScreen state={screen} view={view} token={token} canDownload={signer.sessionOk || !view.document.codeRequired} />;
  }

  return (
    <>
      <Shell workspace={gone ? null : view.workspace} locale={locale} onLocaleChange={onLocaleChange} product={product} wide={screen === "fill" && !gone} bottomSpace={screen === "fill" && !gone}>
        {body}
      </Shell>
      {canDecline ? (
        <DeclineDialog
          open={declineOpen}
          onOpenChange={setDeclineOpen}
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
