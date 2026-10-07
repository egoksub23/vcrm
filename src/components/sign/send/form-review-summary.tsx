"use client";

import { useLocale, useTranslations } from "next-intl";
import { Info, UserCheck } from "lucide-react";

import { roleColorStyle, ROLE_CLASS } from "@/lib/sign/client/colors";
import { asLocale } from "@/lib/sign/client/progress-logic";
import { contactPrefill, roleHolds } from "@/lib/sign/client/progress-send";
import type { SignerRow } from "@/lib/sign/client/signers-form";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { usePartsText } from "./form-roles-card";

interface Props {
  form: FormDefinition;
  roles: readonly SignRole[];
  rows: readonly Pick<SignerRow, "roleKey">[];
  contactId: string | null;
}

/** A contact field as the sender reads it: "name", "email", "company", or the name of a custom field. */
function useContactFieldWord() {
  const t = useTranslations("Sign.progress");
  return (name: string): string => (name === "name" || name === "email" || name === "company" ? t(`contactFields.${name}`) : name.startsWith("custom:") ? name.slice(7) : name);
}

/** Step 4 for a document that carries a form: the parts and who completes them, and whether it starts from the linked contact. */
export function FormReviewSummary({ form, roles, rows, contactId }: Props) {
  const t = useTranslations("Sign.progress.reviewStep");
  const locale = asLocale(useLocale());
  const partsText = usePartsText();
  const word = useContactFieldWord();
  const holds = roleHolds(form, roles, rows, locale).filter((h) => h.mode !== "nothing");
  const prefill = contactPrefill(form, contactId);
  const list = prefill.contactFields.map(word).join(", ");

  return (
    <section aria-labelledby="review-form" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div>
        <h2 id="review-form" className="text-base font-semibold text-foreground">
          {t("title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("summary", { parts: form.parts.length, fields: form.fields.length })}</p>
      </div>
      <ul className="space-y-1.5">
        {holds.map((h) => (
          <li key={h.roleKey} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span style={roleColorStyle(h.color)} className={cn("size-2.5 shrink-0 rounded-full", ROLE_CLASS.dot)} aria-hidden />
            <span className="text-foreground">{t("holds", { mode: h.mode, role: h.roleLabel, count: h.partCount, parts: partsText(h.ranges) })}</span>
          </li>
        ))}
      </ul>

      {prefill.willPrefill && (
        <p className="flex items-start gap-2 border-t border-border pt-3 text-sm text-foreground" role="status">
          <UserCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>{t("prefillOn", { count: prefill.mapped.length, fields: list })}</span>
        </p>
      )}
      {prefill.warnNoContact && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground" role="status">
          <Info className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
          <span>{t("noContact", { fields: list })}</span>
        </p>
      )}
      {!prefill.warnNoContact && !prefill.willPrefill && <p className="border-t border-border pt-3 text-xs text-muted-foreground">{t("noContactFields")}</p>}
    </section>
  );
}
