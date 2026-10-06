"use client";

// ============================================================
// Doc Sign: "Sign now", for a Halo user whose turn it is. Asks the server to open their own turn (a fresh link and the
// session that stands in for the email code, from their Halo sign-in) and goes to the signer page in the same tab.
// Used by the "Awaiting my signature" list and by the document detail, so the call and its refusals read the same.
// ============================================================

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, PenLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import { countersignErrorKey, openMyTurn } from "@/lib/sign/client/countersign";
import { SignApiError } from "@/lib/sign/client/api";

interface Props {
  documentId: string;
  size?: "sm" | "default" | "lg";
  variant?: "default" | "outline";
  /** The server said it is not (or no longer) this person's turn: read the screen again. */
  onRefused?: () => void;
  /** Where to go with the signer page's path; the browser's own navigation unless a test or another screen says otherwise. */
  go?: (path: string) => void;
}

export function SignNowButton({ documentId, size = "sm", variant = "default", onRefused, go = (path) => window.location.assign(path) }: Props) {
  const t = useTranslations("Sign.send.list.awaiting");
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    try {
      go(await openMyTurn(documentId));
      // the page is leaving: the button stays busy so a second click cannot start a second link
    } catch (err) {
      const code = err instanceof SignApiError ? err.code : "request_failed";
      toast.error(t(`errors.${countersignErrorKey(code)}`));
      if (err instanceof SignApiError && err.status === 409) onRefused?.();
      setBusy(false);
    }
  }

  return (
    <Button type="button" size={size} variant={variant} onClick={() => void open()} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <PenLine aria-hidden />}
      {busy ? t("opening") : t("signNow")}
    </Button>
  );
}
