"use client";

// ============================================================
// Doc Sign, signing page: "Forward". Hand your whole turn, or one part of the form, to someone else. A dialog
// with their name and email and an optional note, and a plain statement of what happens, so it is never done by
// accident. Nothing is sent until it is confirmed; the page says what went wrong in words, never as a code.
// ============================================================

import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FORWARD_NOTE_MAX } from "@/lib/sign/forward";

import { FieldError } from "./sheet-parts";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface ForwardValues {
  fullName: string;
  email: string;
  note: string;
}

interface ForwardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The part being forwarded (its title, in the page's language); null for the whole turn. */
  part: { key: string; title: string } | null;
  /** Forwards this position may still make. */
  remaining: number;
  /** Forward. Resolves to the words of what went wrong, or null when it worked. */
  onConfirm: (values: ForwardValues) => Promise<string | null>;
}

export function ForwardDialog({ open, onOpenChange, part, remaining, onConfirm }: ForwardDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="motion-reduce:animate-none motion-reduce:duration-0 sm:max-w-md">
        {open ? <ForwardForm part={part} remaining={remaining} onCancel={() => onOpenChange(false)} onConfirm={onConfirm} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ForwardForm({ part, remaining, onCancel, onConfirm }: { part: ForwardDialogProps["part"]; remaining: number; onCancel: () => void; onConfirm: ForwardDialogProps["onConfirm"] }) {
  const t = useTranslations("Sign.signer");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const emailId = useId();
  const noteId = useId();
  const errorId = useId();
  const detailsId = useId();

  const nameBad = fullName.trim().length === 0 || fullName.trim().length > 160;
  const emailBad = !EMAIL_RE.test(email.trim()) || email.trim().length > 254;

  async function confirm() {
    setTried(true);
    if (nameBad || emailBad) return;
    setBusy(true);
    setError(null);
    const problem = await onConfirm({ fullName: fullName.trim(), email: email.trim(), note: note.trim() });
    // on success the page changes and this dialog goes with it
    setBusy(false);
    if (problem) setError(problem);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-lg leading-snug">{part ? t("forward.titlePart", { part: part.title }) : t("forward.titleTurn")}</DialogTitle>
        <DialogDescription>{part ? t("forward.bodyPart") : t("forward.bodyTurn")}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor={nameId} className="block text-sm font-medium">
            {t("forward.name")}
          </label>
          <Input id={nameId} value={fullName} maxLength={160} autoComplete="off" className="h-11 text-base" aria-invalid={tried && nameBad} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={emailId} className="block text-sm font-medium">
            {t("forward.email")}
          </label>
          <Input id={emailId} type="email" inputMode="email" value={email} maxLength={254} autoComplete="off" className="h-11 text-base" aria-invalid={tried && emailBad} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {tried && (nameBad || emailBad) ? <FieldError id={detailsId}>{t("forward.problemDetails")}</FieldError> : null}
        <div className="space-y-1.5">
          <label htmlFor={noteId} className="block text-sm font-medium">
            {t("forward.note")}
          </label>
          <Textarea id={noteId} value={note} maxLength={FORWARD_NOTE_MAX} rows={3} className="min-h-20 text-base" onChange={(e) => setNote(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t("forward.noteHelp")}</p>
        </div>
        <p className="text-xs text-muted-foreground">{t("forward.left", { count: remaining })}</p>
        {error ? <FieldError id={errorId}>{error}</FieldError> : null}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" className="h-11 text-base" onClick={onCancel} disabled={busy}>
          {t("forward.cancel")}
        </Button>
        <Button type="button" className="h-11 text-base" onClick={() => void confirm()} disabled={busy}>
          {busy ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : null}
          {part ? t("forward.confirmPart") : t("forward.confirmTurn")}
        </Button>
      </div>
    </>
  );
}
