"use client";

// ============================================================
// Doc Sign, a sent collection's people who RECEIVE A COPY (migration 175): listed with the people who sign (they are not signers: no link, no step,
// not counted in "x of y signed", progress or reminders), each with whether the signed copies were sent to them. While the collection is open the
// sender can add one more (a name from the contacts or typed, and an email) or take one off the list.
// ============================================================

import { useState } from "react";
import { Loader2, Mail, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { errorKey } from "@/lib/sign/client/errors";
import { MAX_COPY_RECIPIENTS } from "@/lib/sign/envelopes";
import type { SignCopyRecipientRow } from "@/lib/sign/types";

import { PersonNameInput } from "../send/person-name-input";

/** The statuses of a collection that people can still be added to or removed from. */
export const COPIES_OPEN_STATUSES: ReadonlySet<string> = new Set(["sent", "in_progress"]);

type Copy = Pick<SignCopyRecipientRow, "id" | "full_name" | "email" | "notified_at">;

/** One line for each person who receives a copy: name, address, the "Receives a copy" label, and whether the signed copies went out to them. */
export function CopyRecipientItems({ copies, completed, canChange, busyId, onRemove }: { copies: readonly Copy[]; completed: boolean; canChange: boolean; busyId: string | null; onRemove: (copy: Copy) => void }) {
  const t = useTranslations("Sign.detail.collectionCopies");
  const f = useFormatter();
  return (
    <>
      {copies.map((c) => (
        <li key={c.id} data-copy-recipient className="grid gap-1.5 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 break-words font-medium text-foreground">
                {c.full_name}
                <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground">{t("receivesCopy")}</span>
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Mail className="size-3" aria-hidden />
                  <span className="break-all">{c.email}</span>
                </span>
              </p>
            </div>
            {canChange ? (
              <Button type="button" variant="ghost" size="sm" disabled={busyId !== null} aria-label={t("remove", { name: c.full_name })} onClick={() => onRemove(c)}>
                {busyId === c.id ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
                {t("removeShort")}
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{c.notified_at ? t("sent", { date: f.dateTime(new Date(c.notified_at), { dateStyle: "medium" }) }) : completed ? t("notSent") : t("afterSigned")}</p>
        </li>
      ))}
    </>
  );
}

/** Add a person who receives a copy: their name (the contacts are offered as it is typed) and their email, then Add. */
export function AddCopyRecipient({ envelopeId, count, onAdded }: { envelopeId: string; count: number; onAdded: () => Promise<unknown> }) {
  const t = useTranslations("Sign.detail.collectionCopies");
  const tErr = useTranslations("Sign.send");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const full = count >= MAX_COPY_RECIPIENTS;

  async function add() {
    if (busy || !name.trim() || !email.trim()) return;
    setBusy(true);
    setErrorCode(null);
    try {
      await signRequest(`/api/sign/envelopes/${envelopeId}/copies`, { json: { fullName: name.trim(), email: email.trim() } });
      toast.success(t("added", { name: name.trim() }));
      setName("");
      setEmail("");
      await onAdded();
    } catch (err) {
      const code = err instanceof SignApiError ? err.code : "request_failed";
      setErrorCode(code);
      if (code === "copy_not_open") void onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-2 rounded-xl border border-border bg-card p-4"
      aria-label={t("addHeading")}
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div>
        <h3 className="text-sm font-semibold text-foreground">{t("addHeading")}</h3>
        <p className="text-xs text-muted-foreground">{t("addHint")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="space-y-1">
          <label htmlFor="env-copy-name" className="text-xs font-medium text-foreground">
            {t("name")}
          </label>
          <PersonNameInput
            id="env-copy-name"
            value={name}
            disabled={busy || full}
            onChange={setName}
            onPickContact={(c) => {
              if (c.name?.trim()) setName(c.name.trim());
              if (c.email?.trim()) setEmail(c.email.trim());
            }}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="env-copy-email" className="text-xs font-medium text-foreground">
            {t("email")}
          </label>
          <Input id="env-copy-email" type="email" value={email} maxLength={254} autoComplete="off" disabled={busy || full} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <Button type="submit" variant="outline" disabled={busy || full || !name.trim() || !email.trim()}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
          {t("add")}
        </Button>
      </div>
      {full ? <p className="text-xs text-muted-foreground">{t("limit", { max: MAX_COPY_RECIPIENTS })}</p> : null}
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {tErr(errorKey(errorCode))}
        </p>
      ) : null}
    </form>
  );
}
