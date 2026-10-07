"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyFlags, fillFromContact, type CopyRow } from "@/lib/sign/client/copy-form";
import { cn } from "@/lib/utils";
import { PersonNameInput } from "./person-name-input";
import type { ContactSummary } from "./use-contact-search";

type Field = "name" | "email";

interface Props {
  row: CopyRow;
  /** 0-based position in the copy list. */
  index: number;
  /** Show every problem now (the sender tried to move on). Otherwise a field complains once it has been left. */
  showInvalid: boolean;
  /** A line about this person that is not a missing value (the same address twice, or an address that signs). */
  notice?: string | null;
  readOnly?: boolean;
  /** "Must sign" can be chosen: the document has roles for signers. */
  canSign: boolean;
  /** The signing list is full, so "Must sign" cannot be chosen. */
  signFull?: boolean;
  onChange: (patch: Partial<Omit<CopyRow, "key">>) => void;
  onRemove: () => void;
  /** "Must sign" was chosen: the person moves to the signing list. */
  onMustSign: () => void;
}

const SELECT = "h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-invalid:border-destructive";

/**
 * One person who receives a copy: name (with the contact search), email, the type dropdown and remove. No role, no channel, no step: they get the
 * signed copy by email when everyone has signed, and never a signing link.
 */
export function CopyRowEditor({ row, index, showInvalid, notice, readOnly, canSign, signFull, onChange, onRemove, onMustSign }: Props) {
  const t = useTranslations("Sign.send.people");
  const tc = useTranslations("Sign.send.copies");
  const [left, setLeft] = useState<ReadonlySet<Field>>(new Set());
  const flags = copyFlags(row);
  const shown = (f: Field) => flags[f] && (showInvalid || left.has(f));
  const leave = (f: Field) => setLeft((s) => (s.has(f) ? s : new Set([...s, f])));
  const ids = `copy-${row.key}`;
  const anyShown = shown("name") || shown("email");

  return (
    <li data-copy-row className={cn("rounded-lg border bg-card p-3 transition-colors", anyShown ? "border-destructive/60" : "border-border")}>
      <div className="flex items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-x-3 gap-y-2 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor={`${ids}-name`} className="text-xs font-medium text-muted-foreground">
              {t("fullName")}
            </label>
            <PersonNameInput
              id={`${ids}-name`}
              value={row.fullName}
              disabled={readOnly}
              invalid={shown("name")}
              onBlur={() => leave("name")}
              onChange={(fullName) => onChange({ fullName })}
              onPickContact={(c: ContactSummary) => onChange(fillFromContact(c, row))}
            />
            {shown("name") ? <p className="text-xs text-destructive">{t("nameRequired")}</p> : null}
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-email`} className="text-xs font-medium text-muted-foreground">
              {t("email")}
            </label>
            <Input id={`${ids}-email`} type="email" value={row.email} maxLength={254} autoComplete="off" disabled={readOnly} aria-invalid={shown("email")} onBlur={() => leave("email")} onChange={(e) => onChange({ email: e.target.value })} />
            {shown("email") ? <p className="text-xs text-destructive">{t("emailInvalid")}</p> : null}
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-type`} className="text-xs font-medium text-muted-foreground">
              {tc("type")}
            </label>
            <select id={`${ids}-type`} className={SELECT} value="copy" disabled={readOnly} onChange={(e) => e.target.value === "signer" && onMustSign()}>
              <option value="signer" disabled={!canSign || signFull} title={canSign ? undefined : tc("mustPlaceFields")}>
                {tc("typeSigner")}
              </option>
              <option value="copy">{tc("typeCopy")}</option>
            </select>
          </div>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" className="mt-5 shrink-0" disabled={readOnly} aria-label={tc("remove", { n: index + 1 })} onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
      {notice ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{notice}</p> : null}
    </li>
  );
}
