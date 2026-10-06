"use client";

// ============================================================
// Doc Sign, the detail screen: what happens when the sender asks to remind, resend or change the recipient of a
// person who has not finished. One place for it, used by the People list and by the progress view (which offers
// "Remind about unfinished parts"), so the call, the toasts and the "link, shown once" dialog are the same.
// ============================================================

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { SignApiError, signRequest } from "@/lib/sign/client/api";
import type { SignChannel, SignSignerRow } from "@/lib/sign/types";

import type { RecipientForm } from "./logic";
import { ChangeRecipientDialog, ConfirmSignerStep, LinkDialog, type SignerStep, type UndeliveredLink } from "./signer-dialogs";

/** What the route answers for one person: whether the message went, and the link only if it did not. */
interface ActionResult {
  signerId: string;
  name: string;
  delivery: { channel: SignChannel; status: "sent" | "failed" | "not_configured"; detail?: string };
  link?: string;
  /** The person's step has not begun: their details changed and nothing was sent. */
  notInvitedYet?: boolean;
}

export type OpenDialog = { kind: "remind" | "resend"; signer: SignSignerRow } | { kind: "recipient"; signer: SignSignerRow } | null;

/**
 * The dialogs and calls for the actions on a person. `open` shows the dialog for an action; the dialogs ask first,
 * answer with a toast, and hand over the link once when a message could not be delivered.
 */
export function useSignerActions(documentId: string, onChanged: () => Promise<void>) {
  const t = useTranslations("Sign.detail");
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // One link at a time: showing another person's link replaces this one.
  const [link, setLink] = useState<UndeliveredLink | null>(null);

  function close() {
    if (busy) return;
    setDialog(null);
    setErrorCode(null);
  }

  async function run(signer: SignSignerRow, body: Record<string, unknown>, done: "reminded" | "resent" | "recipientChanged") {
    setBusy(true);
    setErrorCode(null);
    try {
      const { result } = await signRequest<{ result: ActionResult }>(`/api/sign/documents/${documentId}/signers/${signer.id}`, { json: body });
      setDialog(null);
      if (result.notInvitedYet) {
        toast.success(t("toasts.recipientChangedLater", { name: result.name || signer.full_name }));
      } else if (result.delivery.status === "sent" || !result.link) {
        toast.success(t(`toasts.${done}`, { name: result.name || signer.full_name }));
      } else {
        // The message did not arrive: say so, and hand over the link once.
        toast.warning(t(result.delivery.status === "not_configured" ? "toasts.notConfigured" : "toasts.notDelivered", { name: result.name || signer.full_name, channel: t(`channel.${result.delivery.channel}`) }));
        setLink({ signerId: result.signerId, name: result.name || signer.full_name, channel: result.delivery.channel, link: result.link });
      }
      await onChanged();
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      // The state may have moved under us (someone else signed): show it.
      if (err instanceof SignApiError && (err.code === "signer_not_open" || err.code === "document_not_open")) void onChanged();
    } finally {
      setBusy(false);
    }
  }

  return {
    open: (kind: "remind" | "resend" | "recipient", signer: SignSignerRow) => setDialog({ kind, signer }),
    dialog,
    busy,
    errorCode,
    link,
    closeLink: () => setLink(null),
    close,
    run,
  };
}

type Actions = ReturnType<typeof useSignerActions>;

interface DialogsProps {
  actions: Actions;
  /** The titles of the parts a reminder to this person will name (forms), by signer id. */
  partsFor?: (signerId: string) => string[];
}

export function SignerActionDialogs({ actions, partsFor }: DialogsProps) {
  const { dialog, busy, errorCode, link, close, run, closeLink } = actions;

  function submitRecipient(signer: SignSignerRow, f: RecipientForm) {
    void run(signer, { action: "recipient", fullName: f.fullName.trim(), email: f.email.trim(), phone: f.phone.trim() || null, channel: f.channel }, "recipientChanged");
  }

  return (
    <>
      {dialog && dialog.kind !== "recipient" && (
        <ConfirmSignerStep
          key={dialog.signer.id + dialog.kind}
          step={dialog.kind as SignerStep}
          signer={dialog.signer}
          busy={busy}
          errorCode={errorCode}
          parts={dialog.kind === "remind" ? partsFor?.(dialog.signer.id) : undefined}
          onClose={close}
          onConfirm={() => void run(dialog.signer, { action: dialog.kind }, dialog.kind === "remind" ? "reminded" : "resent")}
        />
      )}
      {dialog && dialog.kind === "recipient" && (
        <ChangeRecipientDialog key={dialog.signer.id} signer={dialog.signer} busy={busy} errorCode={errorCode} onClose={close} onSubmit={(f) => submitRecipient(dialog.signer, f)} />
      )}
      {link && <LinkDialog value={link} onClose={closeLink} />}
    </>
  );
}
