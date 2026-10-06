"use client";

// ============================================================
// Doc Sign, the detail screen: the people on a document, in signing order. Each shows role, status, how they
// are reached, when they opened and signed, how many reminders went out, and, while they have not finished,
// the actions Remind, Resend and Change recipient. Every action asks first and answers with a toast; when
// a message could not be delivered the link is offered once, for one person at a time.
// ============================================================

import { useLocale, useTranslations } from "next-intl";
import { Bell, Mail, MessageCircle, Pencil, Send, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SIGN_STATUS_NAMESPACE, signerBadgeClass, signerStatusKey } from "@/lib/sign/client/status";
import { roleColorStyle, ROLE_CLASS } from "@/lib/sign/client/colors";
import type { SignDocumentRow, SignRole, SignSignerRow } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { formatWhen } from "./format";
import { signerActions, type DetailCaps } from "./logic";
import { SignerActionDialogs, useSignerActions } from "./signer-actions";

interface Props {
  document: SignDocumentRow;
  signers: SignSignerRow[];
  /** People whose last message did not arrive. */
  undelivered: ReadonlySet<string>;
  caps: DetailCaps;
  /** Read the document again after an action. */
  onChanged: () => Promise<void>;
  /** Forms: the parts a reminder to a person will name, by signer id (so the confirmation can say so). */
  partsFor?: (signerId: string) => string[];
}

export function PeopleList({ document: doc, signers, undelivered, caps, onChanged, partsFor }: Props) {
  const t = useTranslations("Sign.detail");
  const actions = useSignerActions(doc.id, onChanged);

  const ordered = [...signers].sort((a, b) => a.order_no - b.order_no || a.created_at.localeCompare(b.created_at));

  return (
    <>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label={t("people.title")}>
        {ordered.map((s) => (
          <SignerRow key={s.id} document={doc} signer={s} undelivered={undelivered.has(s.id)} caps={caps} onAction={(kind) => actions.open(kind, s)} />
        ))}
      </ul>
      <SignerActionDialogs actions={actions} partsFor={partsFor} />
    </>
  );
}

function SignerRow({ document: doc, signer, undelivered, caps, onAction }: { document: SignDocumentRow; signer: SignSignerRow; undelivered: boolean; caps: DetailCaps; onAction: (kind: "remind" | "resend" | "recipient") => void }) {
  const t = useTranslations("Sign.detail");
  const ts = useTranslations(SIGN_STATUS_NAMESPACE);
  const locale = useLocale();
  const role: SignRole | undefined = doc.roles_snapshot.find((r) => r.key === signer.role_key);
  // Evaluated on each render: the page re-renders as it is polled, which is often enough for a 24 hour hold.
  const actions = signerActions(doc.status, signer, caps, new Date());
  const ChannelIcon = signer.channel === "whatsapp" ? MessageCircle : Mail;

  return (
    <li className="grid gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-foreground">
            {doc.sign_in_order && <span className="text-muted-foreground">{signer.order_no} ·</span>}
            <span className="break-words">{signer.full_name}</span>
            {role && (
              <span style={roleColorStyle(role.color)} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", ROLE_CLASS.chip)}>
                <span className={cn("size-1.5 rounded-full", ROLE_CLASS.dot)} aria-hidden />
                {role.label}
              </span>
            )}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="break-all">{signer.email}</span>
            {signer.phone && <span>{signer.phone}</span>}
            <span className="inline-flex items-center gap-1">
              <ChannelIcon className="size-3" aria-hidden />
              {t(`channel.${signer.channel}`)}
            </span>
          </p>
        </div>
        <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium", signerBadgeClass(signer.status))}>{ts(signerStatusKey(signer.status, signer.kind))}</span>
      </div>

      {actions.notInvited && <p className="text-xs text-muted-foreground">{t("people.notInvited")}</p>}

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
        {signer.invited_at && <Fact label={t("people.invited")} value={formatWhen(signer.invited_at, locale)} />}
        {signer.viewed_at && <Fact label={t("people.viewed")} value={formatWhen(signer.viewed_at, locale)} />}
        {signer.signed_at && <Fact label={signer.kind === "filler" ? t("people.filled") : t("people.signed")} value={formatWhen(signer.signed_at, locale)} />}
        {signer.declined_at && <Fact label={t("people.declined")} value={formatWhen(signer.declined_at, locale)} />}
        {signer.reminder_count > 0 && <Fact label={t("people.reminders")} value={t("people.remindersValue", { count: signer.reminder_count, when: formatWhen(signer.last_reminded_at, locale) })} />}
      </dl>

      {signer.decline_reason && <p className="text-xs text-foreground">{t("people.declineReason", { reason: signer.decline_reason })}</p>}

      {undelivered && actions.open && (
        <p className="flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300" role="status">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t(signer.channel === "whatsapp" ? "people.undeliveredWhatsapp" : "people.undeliveredEmail")}
        </p>
      )}

      {actions.open && caps.send && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={!actions.remind} onClick={() => onAction("remind")} aria-describedby={actions.remindAfter ? `held-${signer.id}` : undefined}>
            <Bell aria-hidden />
            {t("people.remind")}
          </Button>
          <Button size="sm" variant="outline" disabled={!actions.resend} onClick={() => onAction("resend")}>
            <Send aria-hidden />
            {t("people.resend")}
          </Button>
          <Button size="sm" variant={undelivered ? "default" : "outline"} disabled={!actions.changeRecipient} onClick={() => onAction("recipient")}>
            <Pencil aria-hidden />
            {t("people.changeRecipient")}
          </Button>
          {actions.remindAfter && (
            <span id={`held-${signer.id}`} className="text-xs text-muted-foreground">
              {t("people.remindHeld", { when: formatWhen(actions.remindAfter.toISOString(), locale) })}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="shrink-0">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
