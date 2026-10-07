"use client";

// ============================================================
// Doc Sign, an envelope that was sent (migration 171): what is happening to it as a whole, each document with its state and its signed copy, and
// each PERSON with their state on each document. Remind, resend and change recipient act on the person across all their documents (one message,
// one new link); cancel acts on the whole envelope and is only offered while no document is fully signed. Each document keeps its own page (its
// history and its audit trail); this is the envelope's.
// ============================================================

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bell, Download, ExternalLink, Loader2, Mail, MessageCircle, Pencil, Send } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCapability } from "@/hooks/use-can";
import { useNow } from "@/hooks/use-now";
import type { EnvelopeData } from "@/hooks/use-sign-envelope";
import { SignApiError, documentFileUrl, signRequest } from "@/lib/sign/client/api";
import { errorKey } from "@/lib/sign/client/errors";
import { remindHeldUntil } from "@/lib/sign/defaults";
import { SIGN_STATUS_NAMESPACE, signerBadgeClass, signerStatusKey } from "@/lib/sign/client/status";
import { canVoidEnvelope, documentsDone, peopleFromRows } from "@/lib/sign/envelopes";
import type { SignChannel, SignCopyRecipientRow, SignSignerRow } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { ChangeRecipientDialog, ConfirmSignerStep, LinkDialog, type UndeliveredLink } from "../detail/signer-dialogs";
import { detailErrorKey, type RecipientForm } from "../detail/logic";
import { SealRetry } from "../detail/seal-retry";
import { VoidDialog } from "../detail/void-dialog";
import { PrivateBadge } from "../private-badge";
import { DocumentStatusBadge } from "../send/status-badge";
import { AddCopyRecipient, COPIES_OPEN_STATUSES, CopyRecipientItems } from "./copy-recipients";

interface Props {
  data: EnvelopeData;
  reload: () => Promise<EnvelopeData | null>;
}

interface ActionResult {
  signerId: string;
  name: string;
  delivery: { channel: SignChannel; status: "sent" | "failed" | "not_configured"; detail?: string };
  link?: string;
  notInvitedYet?: boolean;
}

type Open = { kind: "remind" | "resend" | "recipient"; signer: SignSignerRow } | null;

export function EnvelopeDetail({ data, reload }: Props) {
  const t = useTranslations("Sign.send.envelope");
  const td = useTranslations("Sign.detail");
  const tErr = useTranslations("Sign.send");
  const ts = useTranslations(SIGN_STATUS_NAMESPACE);
  const f = useFormatter();
  const canSend = useCapability("sign.send");
  const canVoid = useCapability("sign.void");
  const canSettings = useCapability("sign.settings");
  const now = useNow(60_000);
  const { envelope: env, documents, signers } = data;
  // the people who receive a copy are not signers: they are not in `signers`, so they are not in "x of y signed", the progress or the reminders
  const copies: readonly SignCopyRecipientRow[] = data.copies ?? [];
  const statuses = documents.map((d) => d.status);

  const [open, setOpen] = useState<Open>(null);
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [link, setLink] = useState<UndeliveredLink | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [extending, setExtending] = useState(false);
  const [copyBusy, setCopyBusy] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const day = (iso: string | null) => (iso ? f.dateTime(new Date(iso), { dateStyle: "medium" }) : "");
  const verdict = canVoidEnvelope(statuses);
  const { done, total } = documentsDone(statuses);
  const people = peopleFromRows(signers);
  const rowsOf = (key: string) => signers.filter((s) => (s.party_id ?? s.id) === key);
  const docOf = (id: string) => documents.find((d) => d.id === id);
  const stillOpen = env.status === "sent" || env.status === "in_progress" || env.status === "sealing";
  const canChangeCopies = canSend && COPIES_OPEN_STATUSES.has(env.status);
  const canExtend = canSend && documents.some((d) => d.status === "sent" || d.status === "in_progress");
  const waitingNames = people.filter((p) => rowsOf(p.partyId ?? p.key).some((r) => (r.status === "sent" || r.status === "viewed") && ["sent", "in_progress"].includes(docOf(r.document_id)?.status ?? ""))).map((p) => p.fullName);
  const declinedBy = signers.find((s) => s.status === "declined")?.full_name ?? null;
  const partly = statuses.some((s) => s === "sealing" || s === "completed" || s === "failed") && statuses.some((s) => s === "sent" || s === "in_progress");

  async function run(signer: SignSignerRow, body: Record<string, unknown>, doneKey: "reminded" | "resent" | "recipientChanged") {
    setBusy(true);
    setErrorCode(null);
    try {
      const { result } = await signRequest<{ result: ActionResult }>(`/api/sign/envelopes/${env.id}/people/${signer.id}`, { json: body });
      setOpen(null);
      if (result.notInvitedYet) toast.success(td("toasts.recipientChangedLater", { name: result.name || signer.full_name }));
      else if (result.delivery.status === "sent" || !result.link) toast.success(td(`toasts.${doneKey}`, { name: result.name || signer.full_name }));
      else {
        toast.warning(td(result.delivery.status === "not_configured" ? "toasts.notConfigured" : "toasts.notDelivered", { name: result.name || signer.full_name, channel: td(`channel.${result.delivery.channel}`) }));
        setLink({ signerId: result.signerId, name: result.name || signer.full_name, channel: result.delivery.channel, link: result.link });
      }
      await reload();
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      if (err instanceof SignApiError && (err.code === "signer_not_open" || err.code === "document_not_open")) void reload();
    } finally {
      setBusy(false);
    }
  }
  /** Stop a person receiving the signed copies (while the collection is open). */
  async function removeCopy(copy: Pick<SignCopyRecipientRow, "id" | "full_name">) {
    setCopyBusy(copy.id);
    setCopyError(null);
    try {
      await signRequest(`/api/sign/envelopes/${env.id}/copies/${copy.id}`, { method: "DELETE" });
      toast.success(td("collectionCopies.removed", { name: copy.full_name }));
      await reload();
    } catch (err) {
      const code = err instanceof SignApiError ? err.code : "request_failed";
      setCopyError(code);
      if (code === "copy_not_open" || code === "copy_recipient_not_found") void reload();
    } finally {
      setCopyBusy(null);
    }
  }
  const close = () => {
    if (busy) return;
    setOpen(null);
    setErrorCode(null);
  };

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/sign" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden />
            {t("draft.back")}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 break-words text-xl font-semibold text-foreground">{env.title}</h1>
            <DocumentStatusBadge status={env.status} />
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{t("badge", { count: documents.length })}</span>
            {env.is_private ? <PrivateBadge className="h-5" /> : null}
          </div>
          <p className="text-xs text-muted-foreground">{[env.reference, env.sent_at ? t("detail.sentOn", { date: day(env.sent_at) }) : null, env.expires_at && stillOpen ? t("detail.expiresOn", { date: day(env.expires_at) }) : null].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canExtend ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setExtending(true)}>
              {t("detail.extend")}
            </Button>
          ) : null}
          {canVoid && verdict.ok ? (
            <Button type="button" variant="destructive" size="sm" onClick={() => setVoiding(true)}>
              {t("detail.void")}
            </Button>
          ) : null}
        </div>
      </div>

      <section role="status" className="rounded-xl border border-border bg-card p-4 text-sm">
        <p className="font-medium text-foreground">
          {env.status === "completed"
            ? t("detail.banner.completed", { count: total })
            : env.status === "declined"
              ? declinedBy
                ? t("detail.banner.declinedBy", { name: declinedBy })
                : t("detail.banner.declined")
              : env.status === "expired"
                ? t("detail.banner.expired", { date: day(env.expires_at) })
                : env.status === "voided"
                  ? t("detail.banner.voided")
                  : env.status === "failed"
                    ? t("detail.banner.failed")
                    : env.status === "sealing"
                      ? t("detail.banner.sealing")
                      : waitingNames.length > 0
                        ? t("detail.banner.waiting", { names: waitingNames.join(", "), count: waitingNames.length })
                        : t("detail.banner.sent")}
        </p>
        <p className="text-xs text-muted-foreground">{t("detail.progress", { done, total })}</p>
        {data.stuck && data.stuck.length > 0 ? (
          <div className="mt-2 grid gap-2 rounded-lg bg-muted/50 p-2 text-xs text-foreground">
            <p>{td("sealRetry.collectionNote")}</p>
            {canSettings ? data.stuck.filter((d) => d.error).map((d) => (
              <p key={d.id} className="break-words text-muted-foreground">{td("sealRetry.reasonOn", { title: d.title, error: d.error ?? "" })}</p>
            )) : null}
            {canSend ? <SealRetry path={`/api/sign/envelopes/${env.id}/retry-seal`} onDone={reload} /> : null}
          </div>
        ) : null}
        {env.status === "voided" && env.void_reason ? <p className="mt-1 text-xs text-muted-foreground">{t("detail.banner.reason", { reason: env.void_reason })}</p> : null}
        {partly && stillOpen ? <p className="mt-2 rounded-lg bg-muted/50 p-2 text-xs text-foreground">{t("detail.partly")}</p> : null}
      </section>

      <section aria-labelledby="env-detail-docs" className="space-y-2">
        <h2 id="env-detail-docs" className="text-sm font-semibold text-foreground">
          {t("detail.documents")}
        </h2>
        <ol className="divide-y divide-border rounded-xl border border-border bg-card">
          {documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-foreground">
                  <span className="text-muted-foreground tabular-nums">{d.position}.</span> {d.title}
                </p>
                <p className="text-xs text-muted-foreground">{[d.reference, d.completedAt ? td("banner.completedOn", { date: day(d.completedAt) }) : null].filter(Boolean).join(" · ")}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <DocumentStatusBadge status={d.status} />
                {d.hasFinalFile ? (
                  <a href={documentFileUrl(d.id, "final", true)} className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2.5 text-[0.8rem] font-medium hover:bg-muted">
                    <Download className="size-3.5" aria-hidden />
                    {t("detail.download")}
                  </a>
                ) : null}
                <Link href={`/sign/${d.id}`} className="inline-flex h-7 items-center gap-1 rounded-lg border border-border px-2.5 text-[0.8rem] font-medium hover:bg-muted">
                  <ExternalLink className="size-3.5" aria-hidden />
                  {t("detail.openDocument")}
                </Link>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="env-detail-people" className="space-y-2">
        <h2 id="env-detail-people" className="text-sm font-semibold text-foreground">
          {t("detail.people", { count: people.length })}
        </h2>
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {people.map((p) => {
            const mine = rowsOf(p.partyId ?? p.key);
            const anchor = mine.find((r) => r.id === r.party_id) ?? mine[0];
            const openRows = mine.filter((r) => (r.status === "sent" || r.status === "viewed") && ["sent", "in_progress"].includes(docOf(r.document_id)?.status ?? ""));
            const invitedRows = mine.filter((r) => r.status !== "pending");
            const held = remindHeldUntil(mine.map((r) => r.last_reminded_at).filter((x): x is string => !!x).sort().at(-1) ?? null, new Date(now));
            const signedAny = mine.some((r) => r.status === "signed" || r.status === "declined");
            const ChannelIcon = p.channel === "whatsapp" ? MessageCircle : Mail;
            return (
              <li key={p.key} className="grid gap-2 p-4">
                <div className="min-w-0">
                  <p className="break-words font-medium text-foreground">{p.fullName}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="break-all">{p.email}</span>
                    {p.phone ? <span>{p.phone}</span> : null}
                    <span className="inline-flex items-center gap-1">
                      <ChannelIcon className="size-3" aria-hidden />
                      {td(`channel.${p.channel}`)}
                    </span>
                    {env.sign_in_order ? <span>{t("detail.step", { step: p.step })}</span> : null}
                  </p>
                </div>
                <ul className="flex flex-wrap gap-2">
                  {mine.map((r) => (
                    <li key={r.id} className="flex items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground">{docOf(r.document_id)?.title}</span>
                      <span className={cn("inline-flex h-5 items-center rounded-full px-2 font-medium", signerBadgeClass(r.status))}>{ts(signerStatusKey(r.status, r.kind))}</span>
                    </li>
                  ))}
                </ul>
                {invitedRows.length === 0 ? <p className="text-xs text-muted-foreground">{t("detail.notInvited")}</p> : null}
                {canSend && anchor && (openRows.length > 0 || (invitedRows.length === 0 && stillOpen)) ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {openRows.length > 0 ? (
                      <>
                        <Button type="button" variant="outline" size="sm" disabled={!!held} onClick={() => setOpen({ kind: "remind", signer: anchor })}>
                          <Bell aria-hidden />
                          {td("people.remind")}
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => setOpen({ kind: "resend", signer: anchor })}>
                          <Send aria-hidden />
                          {td("people.resend")}
                        </Button>
                      </>
                    ) : null}
                    {!signedAny ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => setOpen({ kind: "recipient", signer: anchor })}>
                        <Pencil aria-hidden />
                        {td("people.changeRecipient")}
                      </Button>
                    ) : null}
                    {held ? <span className="text-xs text-muted-foreground">{t("detail.remindHeld", { time: f.dateTime(held, { dateStyle: "medium", timeStyle: "short" }) })}</span> : null}
                  </div>
                ) : null}
                {signedAny && openRows.length > 0 && canSend ? <p className="text-xs text-muted-foreground">{t("detail.cannotReplace")}</p> : null}
              </li>
            );
          })}
          <CopyRecipientItems copies={copies} completed={env.status === "completed"} canChange={canChangeCopies} busyId={copyBusy} onRemove={(c) => void removeCopy(c)} />
        </ul>
        {copyError ? (
          <p role="alert" className="text-sm text-destructive">
            {tErr(errorKey(copyError))}
          </p>
        ) : null}
        {canChangeCopies ? <AddCopyRecipient envelopeId={env.id} count={copies.length} onAdded={reload} /> : null}
      </section>

      {open && open.kind !== "recipient" ? (
        <ConfirmSignerStep key={open.signer.id + open.kind} step={open.kind} signer={open.signer} busy={busy} errorCode={errorCode} onClose={close} onConfirm={() => void run(open.signer, { action: open.kind }, open.kind === "remind" ? "reminded" : "resent")} />
      ) : null}
      {open && open.kind === "recipient" ? (
        <ChangeRecipientDialog
          key={open.signer.id}
          signer={open.signer}
          busy={busy}
          errorCode={errorCode}
          onClose={close}
          onSubmit={(form: RecipientForm) => void run(open.signer, { action: "recipient", fullName: form.fullName.trim(), email: form.email.trim(), phone: form.phone.trim() || null, channel: form.channel }, "recipientChanged")}
        />
      ) : null}
      {link ? <LinkDialog value={link} onClose={() => setLink(null)} /> : null}
      {voiding ? <VoidDialog envelopeId={env.id} title={env.title} onClose={() => setVoiding(false)} onVoided={async () => void (await reload())} /> : null}
      {extending ? <ExtendDialog envelopeId={env.id} current={env.expires_at} onClose={() => setExtending(false)} onDone={async () => void (await reload())} /> : null}
    </div>
  );
}

/** More time for everyone: one new date for every document that is still open. */
function ExtendDialog({ envelopeId, current, onClose, onDone }: { envelopeId: string; current: string | null; onClose: () => void; onDone: () => Promise<void> }) {
  const t = useTranslations("Sign.send.envelope.detail.extendDialog");
  const td = useTranslations("Sign.detail");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  async function submit() {
    if (!date) return;
    setBusy(true);
    setErrorCode(null);
    try {
      // the end of the chosen day, in the sender's own time zone
      const [y, m, d] = date.split("-").map(Number);
      await signRequest(`/api/sign/envelopes/${envelopeId}/expiry`, { json: { expiresAt: new Date(y, m - 1, d, 23, 59, 0, 0).toISOString() } });
      toast.success(t("done"));
      onClose();
      await onDone();
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="env-extend-date">{t("label")}</Label>
          <Input id="env-extend-date" type="date" value={date} min={(current ? new Date(current) : new Date()).toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} className="w-44" />
        </div>
        {errorCode ? (
          <p role="alert" className="text-sm text-destructive">
            {td(detailErrorKey(errorCode))}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy || !date}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t("action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
