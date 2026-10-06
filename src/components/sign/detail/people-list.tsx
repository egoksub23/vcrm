"use client";

// ============================================================
// Doc Sign, the detail screen: the people on a document, in signing order. Each shows role, status, how they
// are reached, when they opened and signed, how many reminders went out, and, while they have not finished,
// the actions Remind, Resend and Change recipient. Every action asks first and answers with a toast; when
// a message could not be delivered the link is offered once, for one person at a time.
// ============================================================

import { useLocale, useTranslations } from "next-intl";
import { Bell, Mail, MessageCircle, Pencil, Send, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { asLocale } from "@/lib/sign/client/progress-logic";
import { SIGN_STATUS_NAMESPACE, signerBadgeClass, signerStatusKey } from "@/lib/sign/client/status";
import { roleColorStyle, ROLE_CLASS } from "@/lib/sign/client/colors";
import { pick } from "@/lib/sign/forms/text";
import type { FormDefinition } from "@/lib/sign/forms/types";
import { isDelegate, stepGroups } from "@/lib/sign/forward";
import type { SignDocumentRow, SignRole, SignSignerRow } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { formatWhen } from "./format";
import { detailErrorKey, signerActions, type DetailCaps } from "./logic";
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
  /** Forms: the document's form, so a part handed to someone can be named. */
  form?: FormDefinition | null;
}

export function PeopleList({ document: doc, signers, undelivered, caps, onChanged, partsFor, form }: Props) {
  const t = useTranslations("Sign.detail");
  const locale = asLocale(useLocale());
  const actions = useSignerActions(doc.id, onChanged);

  // People who share an order number are one step; a person who was handed a part of someone's form sits under that someone.
  const holders = signers.filter((s) => !isDelegate(s));
  const groups = doc.sign_in_order ? stepGroups(holders) : [{ step: 0, orderNo: 0, people: [...holders].sort((a, b) => a.order_no - b.order_no || a.created_at.localeCompare(b.created_at)) }];
  const partTitle = (key: string) => {
    const part = form?.parts.find((p) => p.key === key);
    return part ? pick(part.title, locale) || key : key;
  };
  const row = (s: SignSignerRow, nested: boolean) => (
    <SignerRow key={s.id} document={doc} signer={s} signers={signers} nested={nested} partTitle={partTitle} undelivered={undelivered.has(s.id)} caps={caps} onAction={(kind) => actions.open(kind, s)} onChanged={onChanged} />
  );

  return (
    <>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card" aria-label={t("people.title")}>
        {groups.map((g) => (
          <li key={`step-${g.step}`} className="list-none">
            {doc.sign_in_order && (
              <p className="border-b border-border bg-muted/40 px-4 py-1.5 text-xs font-semibold text-muted-foreground" data-step={g.step}>
                {t("people.step", { step: g.step, count: g.people.length })}
              </p>
            )}
            <ul className="divide-y divide-border">
              {g.people.flatMap((s) => [row(s, false), ...signers.filter((d) => d.delegated_by === s.id).map((d) => row(d, true))])}
            </ul>
          </li>
        ))}
      </ul>
      <SignerActionDialogs actions={actions} partsFor={partsFor} />
    </>
  );
}

interface SignerRowProps {
  document: SignDocumentRow;
  signer: SignSignerRow;
  signers: SignSignerRow[];
  /** A person handed a part of the form: shown under the person who handed it. */
  nested: boolean;
  partTitle: (key: string) => string;
  undelivered: boolean;
  caps: DetailCaps;
  onAction: (kind: "remind" | "resend" | "recipient") => void;
  onChanged: () => Promise<void>;
}

function SignerRow({ document: doc, signer, signers, nested, partTitle, undelivered, caps, onAction, onChanged }: SignerRowProps) {
  const t = useTranslations("Sign.detail");
  const ts = useTranslations(SIGN_STATUS_NAMESPACE);
  const locale = useLocale();
  const { user } = useAuth();
  const role: SignRole | undefined = doc.roles_snapshot.find((r) => r.key === signer.role_key);
  // Evaluated on each render: the page re-renders as it is polled, which is often enough for a 24 hour hold.
  const actions = signerActions(doc.status, signer, caps, new Date(), doc.sign_in_order);
  const ChannelIcon = signer.channel === "whatsapp" ? MessageCircle : Mail;
  const history = signer.forward_history ?? [];
  const giver = nested ? signers.find((s) => s.id === signer.delegated_by) : null;

  return (
    <li className={cn("grid gap-3 p-4", nested && "border-l-2 border-l-primary/30 bg-muted/20 pl-6")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-foreground">
            <span className="break-words">{signer.full_name}</span>
            {/* a Halo user (a countersigner): named so the sender knows this place is signed from inside Halo */}
            {signer.internal_user_id && (
              <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {t(user?.id === signer.internal_user_id ? "people.haloUserYou" : "people.haloUser")}
              </span>
            )}
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
      {actions.move && <MoveStep document={doc} signer={signer} signers={signers} onChanged={onChanged} />}
      {isDelegate(signer) && (
        <p className="text-xs text-foreground">{t("people.holdsParts", { count: (signer.part_keys ?? []).length, parts: (signer.part_keys ?? []).map(partTitle).join(", "), name: giver?.full_name ?? "" })}</p>
      )}
      {history.length > 0 && <p className="text-xs text-muted-foreground">{t("people.forwardedFrom", { names: history.map((h) => h.name).join(", ") })}</p>}

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

/** F-70: a person whose step has not begun can be moved to a later step (or to a new last step). */
function MoveStep({ document: doc, signer, signers, onChanged }: { document: SignDocumentRow; signer: SignSignerRow; signers: SignSignerRow[]; onChanged: () => Promise<void> }) {
  const t = useTranslations("Sign.detail");
  const holders = signers.filter((s) => !isDelegate(s));
  const began = Math.max(0, ...holders.filter((s) => s.status !== "pending").map((s) => s.order_no));
  const steps = stepGroups(holders).filter((g) => g.orderNo > began);
  const last = Math.max(0, ...holders.map((s) => s.order_no));

  async function move(orderNo: number) {
    if (orderNo === signer.order_no) return;
    try {
      await signRequest(`/api/sign/documents/${doc.id}/signers/${signer.id}`, { json: { action: "move", orderNo } });
      toast.success(t("people.moved", { name: signer.full_name }));
      await onChanged();
    } catch (err) {
      toast.error(t(detailErrorKey(err instanceof SignApiError ? err.code : "request_failed")));
      await onChanged();
    }
  }

  return (
    <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {t("people.moveTo")}
      <select
        className="h-8 rounded-lg border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={signer.order_no}
        onChange={(e) => void move(Number(e.target.value))}
      >
        {steps.map((g) => (
          <option key={g.orderNo} value={g.orderNo}>
            {t("people.moveStep", { step: g.step })}
          </option>
        ))}
        <option value={last + 1}>{t("people.moveNew")}</option>
      </select>
    </label>
  );
}
