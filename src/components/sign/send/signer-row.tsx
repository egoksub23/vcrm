"use client";

import { useState, type DragEvent } from "react";
import { ChevronDown, ChevronUp, GripVertical, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ROLE_CLASS, roleColorStyle } from "@/lib/sign/client/colors";
import { fillFromContact } from "@/lib/sign/client/copy-form";
import { rowFlags, type SignerRow } from "@/lib/sign/client/signers-form";
import type { SignChannel, SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";
import { PersonNameInput } from "./person-name-input";
import type { ContactSummary } from "./use-contact-search";

type Field = "name" | "email" | "phone" | "role";

interface Props {
  row: SignerRow;
  /** 0-based position in the list. */
  index: number;
  count: number;
  roles: readonly SignRole[];
  ordered: boolean;
  /** Show every problem now (the sender tried to move on). Otherwise a field complains once it has been left. */
  showInvalid: boolean;
  /** A line about this row that is not a missing value (the same email twice). */
  notice?: { text: string; blocking: boolean } | null;
  whatsappConfigured: boolean | null;
  readOnly?: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onChange: (patch: Partial<Omit<SignerRow, "key">>) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
  /** Give this person a step number: the same number as another person's puts them in that step. */
  onStep: (step: number) => void;
  /** Open the list of Halo users to name one for this row. Absent: the row cannot be given a Halo user (the envelope's list). */
  onChooseHalo?: () => void;
  /** The type dropdown ("Must sign" / "Receives a copy"). Absent: the row has no type (the person must sign). Choosing "Receives a copy" moves the person to the copy list. */
  onReceiveCopy?: () => void;
  /** The copy list is full, so "Receives a copy" cannot be chosen. */
  copyFull?: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
}

const SELECT = "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-invalid:border-destructive";

/** One person on the signing list: name, email, role, channel (and a phone number for WhatsApp), with the order handles when order is on. */
export function SignerRowEditor({ row, index, count, roles, ordered, showInvalid, notice, whatsappConfigured, readOnly, dragging, dropTarget, onChange, onRemove, onMove, onStep, onChooseHalo, onReceiveCopy, copyFull, onDragStart, onDragOver, onDrop, onDragEnd }: Props) {
  const t = useTranslations("Sign.send.people");
  const tc = useTranslations("Sign.send.copies");
  const [left, setLeft] = useState<ReadonlySet<Field>>(new Set());
  const flags = rowFlags(row, roles);
  const shown = (f: Field) => flags[f] && (showInvalid || left.has(f));
  const leave = (f: Field) => setLeft((s) => (s.has(f) ? s : new Set([...s, f])));
  const n = index + 1;
  const role = roles.find((r) => r.key === row.roleKey);
  const anyShown = shown("name") || shown("email") || shown("phone") || shown("role") || !!notice?.blocking;
  const ids = `signer-${row.key}`;
  const halo = !!row.internalUserId;

  return (
    <li
      className={cn("rounded-lg border bg-card p-3 transition-colors", anyShown ? "border-destructive/60" : "border-border", dragging && "opacity-50", dropTarget && "ring-2 ring-primary")}
      onDragOver={ordered ? onDragOver : undefined}
      onDrop={ordered ? onDrop : undefined}
    >
      <div className="flex items-start gap-2">
        {ordered ? (
          <div className="flex w-12 shrink-0 flex-col items-center gap-0.5 pt-5">
            <span
              draggable={!readOnly}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              aria-hidden
              title={t("dragHandle")}
              className="flex size-6 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing"
            >
              <GripVertical className="size-4" />
            </span>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={count}
              value={row.step}
              disabled={readOnly}
              aria-label={t("stepNumber", { n })}
              title={t("stepNumberHint")}
              className="h-7 w-12 px-1 text-center text-xs font-semibold"
              onChange={(e) => onStep(Number(e.target.value))}
            />
            <Button type="button" variant="ghost" size="icon-xs" disabled={readOnly || index === 0} aria-label={t("moveUp", { n })} onClick={() => onMove(-1)}>
              <ChevronUp />
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" disabled={readOnly || index === count - 1} aria-label={t("moveDown", { n })} onClick={() => onMove(1)}>
              <ChevronDown />
            </Button>
          </div>
        ) : null}

        <div className={cn("grid min-w-0 flex-1 gap-x-3 gap-y-2 sm:grid-cols-2", onReceiveCopy ? "xl:grid-cols-5" : "xl:grid-cols-4")}>
          <div className="space-y-1">
            <label htmlFor={`${ids}-name`} className="text-xs font-medium text-muted-foreground">
              {t("fullName")}
            </label>
            {/* typing a name offers the matching contacts; choosing one fills the name and the email (the email stays editable) */}
            <PersonNameInput
              id={`${ids}-name`}
              value={row.fullName}
              disabled={readOnly}
              invalid={shown("name")}
              readOnly={halo}
              onBlur={() => leave("name")}
              onChange={(fullName) => onChange({ fullName })}
              onPickContact={(c: ContactSummary) => onChange({ ...fillFromContact(c, row), ...(row.channel === "whatsapp" && !row.phone.trim() && c.phone?.trim() ? { phone: c.phone.trim() } : {}) })}
            />
            {shown("name") ? <p className="text-xs text-destructive">{t("nameRequired")}</p> : null}
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-email`} className="text-xs font-medium text-muted-foreground">
              {t("email")}
            </label>
            <Input id={`${ids}-email`} type="email" value={row.email} maxLength={254} autoComplete="off" disabled={readOnly} aria-invalid={shown("email")} readOnly={halo} onBlur={() => leave("email")} onChange={(e) => onChange({ email: e.target.value })} />
            {shown("email") ? <p className="text-xs text-destructive">{t("emailInvalid")}</p> : null}
          </div>
          {onReceiveCopy ? (
            <div className="space-y-1">
              <label htmlFor={`${ids}-type`} className="text-xs font-medium text-muted-foreground">
                {tc("type")}
              </label>
              <select id={`${ids}-type`} className={SELECT} value="signer" disabled={readOnly} onChange={(e) => e.target.value === "copy" && onReceiveCopy()}>
                <option value="signer">{tc("typeSigner")}</option>
                <option value="copy" disabled={copyFull}>
                  {tc("typeCopy")}
                </option>
              </select>
            </div>
          ) : null}
          <div className="space-y-1">
            <label htmlFor={`${ids}-role`} className="text-xs font-medium text-muted-foreground">
              {t("role")}
            </label>
            <div className="flex items-center gap-2">
              {role ? <span className={cn("size-2.5 shrink-0 rounded-full", ROLE_CLASS.dot)} style={roleColorStyle(role.color)} aria-hidden /> : null}
              <select id={`${ids}-role`} className={SELECT} value={row.roleKey} disabled={readOnly} aria-invalid={shown("role")} onBlur={() => leave("role")} onChange={(e) => onChange({ roleKey: e.target.value })}>
                {role ? null : <option value="">{t("chooseRole")}</option>}
                {roles.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label} ({r.kind === "signer" ? t("kindSigner") : t("kindFiller")})
                  </option>
                ))}
              </select>
            </div>
            {shown("role") ? <p className="text-xs text-destructive">{t("roleRequired")}</p> : null}
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-channel`} className="text-xs font-medium text-muted-foreground">
              {t("sendBy")}
            </label>
            <select id={`${ids}-channel`} className={SELECT} value={row.channel} disabled={readOnly} onChange={(e) => onChange({ channel: e.target.value as SignChannel })}>
              <option value="email">{t("channelEmail")}</option>
              <option value="whatsapp">{t("channelWhatsapp")}</option>
            </select>
          </div>
          {halo ? (
            // a Halo user signs from inside Halo; the invitation still goes to their email, so the name and email are theirs and are not typed
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2 xl:col-span-full">
              <span data-halo-user className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground">
                <ShieldCheck className="size-3" aria-hidden />
                {t("haloUserTag")}
              </span>
              <span className="text-xs text-muted-foreground">{t("haloUserNote")}</span>
              <Button type="button" variant="ghost" size="xs" disabled={readOnly} onClick={() => onChange({ internalUserId: null })}>
                {t("haloUserRemove")}
              </Button>
            </div>
          ) : onChooseHalo ? (
            <div className="sm:col-span-2 xl:col-span-full">
              <Button type="button" variant="ghost" size="xs" disabled={readOnly} onClick={onChooseHalo}>
                <ShieldCheck aria-hidden />
                {t("chooseHaloUser")}
              </Button>
            </div>
          ) : null}
          {row.channel === "whatsapp" ? (
            <div className="space-y-1 sm:col-span-2 xl:col-span-full">
              <label htmlFor={`${ids}-phone`} className="text-xs font-medium text-muted-foreground">
                {t("phone")}
              </label>
              <Input id={`${ids}-phone`} type="tel" inputMode="tel" value={row.phone} placeholder="+60 12 345 6789" maxLength={32} autoComplete="off" disabled={readOnly} aria-invalid={shown("phone")} onBlur={() => leave("phone")} onChange={(e) => onChange({ phone: e.target.value })} className="sm:max-w-xs" />
              {shown("phone") ? <p className="text-xs text-destructive">{t("phoneInvalid")}</p> : null}
              <p className="text-xs text-muted-foreground">{whatsappConfigured === false ? t("whatsappNotSetUp") : t("whatsappNote")}</p>
            </div>
          ) : null}
        </div>

        <Button type="button" variant="ghost" size="icon-sm" className="mt-5 shrink-0" disabled={readOnly} aria-label={t("remove", { n })} onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
      {notice ? <p className={cn("mt-2 text-xs", notice.blocking ? "text-destructive" : "text-amber-700 dark:text-amber-300")}>{notice.text}</p> : null}
    </li>
  );
}
