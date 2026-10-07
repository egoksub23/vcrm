"use client";

// ============================================================
// Doc Sign, the sender's "Try again" for a signed copy that could not be made (a document marked "could not finish", or one whose attempts keep
// failing). Everything the people signed is kept; this asks the server to seal again (service/seal-retry.ts). Used on a document's own page and on
// a collection's page, which differ only in the address they ask.
// ============================================================

import { useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SignApiError, signRequest } from "@/lib/sign/client/api";

import { detailErrorKey } from "./logic";

interface Props {
  /** `/api/sign/documents/<id>/retry-seal` or `/api/sign/envelopes/<id>/retry-seal`. */
  path: string;
  /** Called after the request went through, to read the page again. */
  onDone: () => Promise<unknown> | void;
}

export function SealRetry({ path, onDone }: Props) {
  const t = useTranslations("Sign.detail");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setCode(null);
    try {
      await signRequest(path, { json: {} });
      toast.success(t("sealRetry.started"));
      await onDone();
    } catch (err) {
      const failure = err instanceof SignApiError ? err.code : "request_failed";
      setCode(failure);
      // it was sealed, or put back to be sealed, in the meantime: the page is read again so it says what is true now
      if (failure === "seal_not_stuck") void onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-1.5">
      <div>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void retry()}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />}
          {t("sealRetry.button")}
        </Button>
      </div>
      {code ? (
        <p role="alert" className="text-sm text-destructive">
          {t(detailErrorKey(code))}
        </p>
      ) : null}
    </div>
  );
}
