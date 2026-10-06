"use client";

// Doc Sign, the detail screen: the three dialogs behind the actions on a person who has not finished.
//   - confirm a reminder or a new invitation (each replaces the person's link),
//   - change the recipient (a different person or address, same place in the order),
//   - the link, when the message could not be delivered: shown once, never kept.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { SignChannel, SignSignerRow } from "@/lib/sign/types";

import { detailErrorKey, recipientProblems, type RecipientForm } from "./logic";

export type SignerStep = "remind" | "resend";

interface ConfirmProps {
  step: SignerStep;
  signer: SignSignerRow;
  busy: boolean;
  /** A failure code from the last try. */
  errorCode: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmSignerStep({ step, signer, busy, errorCode, onConfirm, onClose }: ConfirmProps) {
  const t = useTranslations("Sign.detail");
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(`confirm.${step}.title`, { name: signer.full_name })}</DialogTitle>
          <DialogDescription>{t(`confirm.${step}.body`, { name: signer.full_name, channel: t(`channel.${signer.channel}`) })}</DialogDescription>
        </DialogHeader>
        {errorCode && (
          <p role="alert" className="text-sm text-destructive">
            {t(detailErrorKey(errorCode))}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("confirm.cancel")}
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            {t(`confirm.${step}.action`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RecipientProps {
  signer: SignSignerRow;
  busy: boolean;
  errorCode: string | null;
  onSubmit: (form: RecipientForm) => void;
  onClose: () => void;
}

export function ChangeRecipientDialog({ signer, busy, errorCode, onSubmit, onClose }: RecipientProps) {
  const t = useTranslations("Sign.detail");
  const [form, setForm] = useState<RecipientForm>({ fullName: signer.full_name, email: signer.email, phone: signer.phone ?? "", channel: signer.channel });
  const [tried, setTried] = useState(false);
  const problems = recipientProblems(form);
  const has = (p: (typeof problems)[number]) => tried && problems.includes(p);

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            if (problems.length === 0) onSubmit(form);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("recipient.title", { name: signer.full_name })}</DialogTitle>
            <DialogDescription>{t("recipient.body")}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="sign-recipient-name">{t("recipient.fullName")}</Label>
            <Input id="sign-recipient-name" value={form.fullName} autoComplete="off" aria-invalid={has("name")} aria-describedby={has("name") ? "sign-recipient-name-err" : undefined} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            {has("name") && (
              <p id="sign-recipient-name-err" className="text-xs text-destructive">
                {t("recipient.problems.name")}
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="sign-recipient-email">{t("recipient.email")}</Label>
            <Input id="sign-recipient-email" type="email" value={form.email} autoComplete="off" aria-invalid={has("email")} aria-describedby={has("email") ? "sign-recipient-email-err" : undefined} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            {has("email") && (
              <p id="sign-recipient-email-err" className="text-xs text-destructive">
                {t("recipient.problems.email")}
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="sign-recipient-phone">{t("recipient.phone")}</Label>
            <Input id="sign-recipient-phone" type="tel" value={form.phone} placeholder="+60123456789" autoComplete="off" aria-invalid={has("phone")} aria-describedby={has("phone") ? "sign-recipient-phone-err" : undefined} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            {has("phone") && (
              <p id="sign-recipient-phone-err" className="text-xs text-destructive">
                {t(form.channel === "whatsapp" ? "recipient.problems.phoneRequired" : "recipient.problems.phone")}
              </p>
            )}
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t("recipient.channel")}</legend>
            <RadioGroup value={form.channel} onValueChange={(v) => setForm({ ...form, channel: v === "whatsapp" ? "whatsapp" : "email" })} className="grid-cols-2">
              {(["email", "whatsapp"] as const).map((c) => (
                <Label key={c} htmlFor={`sign-recipient-channel-${c}`} className="cursor-pointer rounded-lg border border-border px-3 py-2 has-data-checked:border-primary">
                  <RadioGroupItem id={`sign-recipient-channel-${c}`} value={c} />
                  {t(`channel.${c}`)}
                </Label>
              ))}
            </RadioGroup>
          </fieldset>

          <p className="text-xs text-muted-foreground">{t("recipient.note")}</p>

          {errorCode && (
            <p role="alert" className="text-sm text-destructive">
              {t(detailErrorKey(errorCode))}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t("confirm.cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              {t("recipient.action")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface UndeliveredLink {
  signerId: string;
  name: string;
  channel: SignChannel;
  /** Held in memory for this dialog only: never written anywhere. */
  link: string;
}

export function LinkDialog({ value, onClose }: { value: UndeliveredLink; onClose: () => void }) {
  const t = useTranslations("Sign.detail");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value.link);
      setCopied(true);
      toast.success(t("link.copied"));
    } catch {
      toast.error(t("link.copyFailed"));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("link.title", { name: value.name })}</DialogTitle>
          <DialogDescription>{t("link.body", { name: value.name, channel: t(`channel.${value.channel}`) })}</DialogDescription>
        </DialogHeader>
        <div role="alert" className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <p>{t("link.warning", { name: value.name })}</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="sign-undelivered-link">{t("link.label")}</Label>
          <div className="flex gap-2">
            <Input id="sign-undelivered-link" readOnly value={value.link} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 font-mono text-xs" />
            <Button type="button" variant="outline" onClick={() => void copy()}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {t(copied ? "link.copiedShort" : "link.copy")}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t("link.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
