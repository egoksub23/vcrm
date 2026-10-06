"use client";

// ============================================================
// Doc Sign, signing page: the list of this person's fields in reading order, each with its state in
// words. Beside the page on a computer; below it on a phone. It is also the way to every field for a
// person using a screen reader or only the keyboard.
// ============================================================

import { AlertCircle, Check, Circle, Lock } from "lucide-react";
import { useTranslations } from "next-intl";

import type { PlacedField } from "@/lib/sign/pdf/types";
import { cn } from "@/lib/utils";

import type { MyFieldView } from "./field-layer";
import { useFieldLabel } from "./field-sheet";
import { useProblemText } from "./sheet-parts";

interface FieldListProps {
  id: string;
  mine: MyFieldView[];
  system: PlacedField[];
  onJump: (field: PlacedField) => void;
}

export function FieldList({ id, mine, system, onJump }: FieldListProps) {
  const t = useTranslations("Sign.signer");
  const labelOf = useFieldLabel();
  const problemText = useProblemText();

  return (
    <section id={id} tabIndex={-1} aria-labelledby={`${id}-title`} className="rounded-xl border bg-card p-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      <h2 id={`${id}-title`} className="px-1 pb-2 text-sm font-semibold">
        {t("fill.fieldList")}
      </h2>
      <ul className="space-y-1">
        {mine.map(({ field, status, problemCode }) => {
          const problem = status === "invalid" ? problemText(problemCode) : null;
          return (
            <li key={field.key}>
              <button
                type="button"
                onClick={() => onJump(field)}
                className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <StatusIcon status={status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{labelOf(field)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t("fill.onPage", { page: field.page + 1 })}
                    {" · "}
                    <span className={cn(status === "invalid" && "font-medium text-red-700 dark:text-red-400")}>{t(`status.${status}`)}</span>
                    {field.required && status !== "done" ? ` · ${t("sheet.required")}` : ""}
                  </span>
                  {problem ? <span className="block text-xs font-medium text-red-700 dark:text-red-400">{problem}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
        {system.map((field) => (
          <li key={field.key} className="flex min-h-11 items-center gap-3 px-2 py-1.5 text-sm text-muted-foreground">
            <Lock className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{labelOf(field)}</span>
              <span className="block text-xs">
                {t("fill.onPage", { page: field.page + 1 })}
                {" · "}
                {t("status.system")}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusIcon({ status }: { status: MyFieldView["status"] }) {
  if (status === "done") return <Check className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />;
  if (status === "invalid") return <AlertCircle className="size-5 shrink-0 text-red-700 dark:text-red-400" aria-hidden />;
  return <Circle className="size-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />;
}
