"use client";

// ============================================================
// Doc Sign, the detail screen: the people who RECEIVE A COPY of a document on its own (migration 175). They are listed apart from the signers
// ("Receives a copy", and when the signed copy was sent to each), never counted in the progress, the reminders or the signers table. While the
// document is open (sent or in progress) the sender can add one more or remove one; once it is completed the list is only read. A document of a
// collection shows nothing of its own: its copy people are the collection's.
// ============================================================

import { useState } from "react";
import { Loader2, Mail, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PersonNameInput } from "@/components/sign/send/person-name-input";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { copyFlags, fillFromContact } from "@/lib/sign/client/copy-form";
import { errorKey } from "@/lib/sign/client/errors";
import { MAX_COPY_RECIPIENTS } from "@/lib/sign/envelopes";
import type { SignCopyRecipientRow, SignDocumentRow } from "@/lib/sign/types";

import { formatWhen } from "./format";

interface Props {
  document: SignDocumentRow;
  copies: readonly SignCopyRecipientRow[];
  /** The viewer may send (`sign.send`): they can add and remove people while the document is open. */
  canSend: boolean;
  /** Read the document again after a change. */
  onChanged: () => Promise<void>;
}

/** Statuses in which the signed copy is still to come (or has gone out). */
const COPY_STILL_COMING = new Set(["draft", "sent", "in_progress", "sealing", "completed"]);

export function CopyRecipients({ document: doc, copies, canSend, onChanged }: Props) {
  const t = useTranslations("Sign.detail");
  const tErr = useTranslations("Sign.send");
  const locale = useLocale();
  const [adding, setAdding] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // a document of a collection takes none of its own
  if (doc.envelope_id) return null;
  const open = doc.status === "sent" || doc.status === "in_progress";
  const canEdit = canSend && open;
  if (copies.length === 0 && !canEdit) return null;

  const canAddMore = copies.length < MAX_COPY_RECIPIENTS;
  const flags = copyFlags({ fullName, email });
  const reset = () => {
    setAdding(false);
    setFullName("");
    setEmail("");
    setTried(false);
  };

  const fail = (err: unknown) => toast.error(tErr(errorKey(err instanceof SignApiError ? err.code : "request_failed")));

  async function add() {
    setTried(true);
    if (flags.name || flags.email) return;
    setBusy("add");
    try {
      await signRequest(`/api/sign/documents/${doc.id}/copies`, { method: "POST", json: { fullName: fullName.trim(), email: email.trim() } });
      toast.success(t("copies.added", { name: fullName.trim() }));
      reset();
      await onChanged();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function remove(copy: SignCopyRecipientRow) {
    setBusy(copy.id);
    try {
      await signRequest(`/api/sign/documents/${doc.id}/copies/${copy.id}`, { method: "DELETE" });
      toast.success(t("copies.removed", { name: copy.full_name }));
      await onChanged();
    } catch (err) {
      fail(err);
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  const statusOf = (c: SignCopyRecipientRow): string => (c.notified_at ? t("copies.sent", { date: formatWhen(c.notified_at, locale) }) : COPY_STILL_COMING.has(doc.status) ? t("copies.notSent") : t("copies.notSentFinal"));

  return (
    <section aria-labelledby="detail-copies-title" data-copy-recipients className="grid gap-3">
      <div>
        <h3 id="detail-copies-title" className="text-sm font-semibold text-foreground">
          {t("copies.title")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("copies.help")}</p>
      </div>

      {copies.length > 0 ? (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label={t("copies.title")}>
          {copies.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 p-4">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-foreground">
                  <span className="break-words">{c.full_name}</span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    <Mail className="size-3" aria-hidden />
                    {t("copies.label")}
                  </span>
                </p>
                <p className="mt-0.5 break-all text-xs text-muted-foreground">{c.email}</p>
                <p className="mt-1 text-xs text-muted-foreground">{statusOf(c)}</p>
              </div>
              {canEdit ? (
                <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-label={t("copies.remove", { name: c.full_name })} onClick={() => void remove(c)}>
                  {busy === c.id ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {canEdit ? (
        adding ? (
          <div className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="copy-add-name" className="text-xs font-medium text-muted-foreground">
                {t("copies.fullName")}
              </label>
              <PersonNameInput id="copy-add-name" value={fullName} invalid={tried && flags.name} onChange={setFullName} onPickContact={(c) => {
                const filled = fillFromContact(c, { fullName, email });
                setFullName(filled.fullName);
                setEmail(filled.email);
              }} />
              {tried && flags.name ? <p className="text-xs text-destructive">{t("copies.nameRequired")}</p> : null}
            </div>
            <div className="space-y-1">
              <label htmlFor="copy-add-email" className="text-xs font-medium text-muted-foreground">
                {t("copies.email")}
              </label>
              <Input id="copy-add-email" type="email" value={email} maxLength={254} autoComplete="off" aria-invalid={tried && flags.email} onChange={(e) => setEmail(e.target.value)} />
              {tried && flags.email ? <p className="text-xs text-destructive">{t("copies.emailInvalid")}</p> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
              <Button type="button" size="sm" disabled={busy !== null} onClick={() => void add()}>
                {busy === "add" ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
                {t("copies.submit")}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={reset}>
                {t("copies.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={!canAddMore} onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              {t("copies.add")}
            </Button>
            {!canAddMore ? <p className="text-xs text-muted-foreground">{t("copies.limit", { max: MAX_COPY_RECIPIENTS })}</p> : null}
          </div>
        )
      ) : null}
    </section>
  );
}
