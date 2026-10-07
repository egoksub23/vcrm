"use client";

import { useLocale, useTranslations } from "next-intl";
import { TriangleAlert } from "lucide-react";

import { roleColorStyle, ROLE_CLASS } from "@/lib/sign/client/colors";
import { asLocale } from "@/lib/sign/client/progress-logic";
import { roleHolds, type RoleHolds } from "@/lib/sign/client/progress-send";
import type { SignerRow } from "@/lib/sign/client/signers-form";
import type { FormDefinition } from "@/lib/sign/forms/types";
import type { SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

interface Props {
  form: FormDefinition;
  roles: readonly SignRole[];
  rows: readonly Pick<SignerRow, "roleKey">[];
}

/** The parts a list of ranges names ("1 to 4 and 6"), in the reader's language. */
export function usePartsText() {
  const t = useTranslations("Sign.progress.peopleStep");
  const locale = useLocale();
  return (ranges: RoleHolds["ranges"]): string => {
    const items = ranges.map((r) => (r.from === r.to ? String(r.from) : t("range", { from: r.from, to: r.to })));
    try {
      return new Intl.ListFormat(locale, { type: "conjunction", style: "long" }).format(items);
    } catch {
      return items.join(", ");
    }
  };
}

/**
 * Step 2 for a document that carries a form: who completes which parts and who signs, role by role, so the sender knows
 * before sending. A role with parts and nobody on the list is flagged.
 */
export function FormRolesCard({ form, roles, rows }: Props) {
  const t = useTranslations("Sign.progress.peopleStep");
  const locale = asLocale(useLocale());
  const partsText = usePartsText();
  const holds = roleHolds(form, roles, rows, locale).filter((h) => h.mode !== "nothing");

  return (
    <section aria-labelledby="form-roles-title" className="space-y-2 rounded-xl border border-border bg-card p-4">
      <div>
        <h2 id="form-roles-title" className="text-sm font-semibold text-foreground">
          {t("title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("note")}</p>
      </div>
      <ul className="space-y-2">
        {holds.map((h) => (
          <li key={h.roleKey} className="grid gap-0.5 text-sm">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span style={roleColorStyle(h.color)} className={cn("size-2.5 shrink-0 rounded-full", ROLE_CLASS.dot)} aria-hidden />
              <span className="text-foreground">{t("holds", { mode: h.mode, role: h.roleLabel, count: h.partCount, parts: partsText(h.ranges) })}</span>
            </span>
            {h.titles.length > 0 && <span className="break-words text-xs text-muted-foreground">{h.titles.join(", ")}</span>}
            {!h.hasPerson && (
              <span className="flex items-start gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300" role="status">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t("nobody", { role: h.roleLabel })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
