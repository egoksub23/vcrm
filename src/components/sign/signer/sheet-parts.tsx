"use client";

// Small pieces the field sheets share.

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The row of buttons at the bottom of a sheet: the main action, and a way to take the answer back. */
export function SheetActions({
  onApply,
  applyLabel,
  applyDisabled,
  applyBusy,
  onClear,
  clearLabel,
}: {
  onApply: () => void;
  applyLabel: string;
  applyDisabled?: boolean;
  applyBusy?: boolean;
  onClear?: () => void;
  clearLabel?: string;
}) {
  return (
    <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
      {onClear ? (
        <Button type="button" variant="outline" className="h-11 text-base sm:min-w-28" onClick={onClear}>
          {clearLabel}
        </Button>
      ) : null}
      <Button type="button" className="h-11 text-base sm:min-w-28" onClick={onApply} disabled={applyDisabled || applyBusy}>
        {applyLabel}
      </Button>
    </div>
  );
}

/** A message under a control: it is announced and tied to the control by `id`. */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
      {children}
    </p>
  );
}

/** A big, plain label above a control. */
export function SheetLabel({ htmlFor, children, className }: { htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn("block text-sm font-medium text-foreground", className)}>
      {children}
    </label>
  );
}

/** The words for an answer that was not acceptable: the reason, or a general sentence when the reason is new. */
export function useProblemText(): (code: string | null | undefined) => string | null {
  const t = useTranslations("Sign.signer");
  return (code) => {
    if (!code) return null;
    return t.has(`problems.${code}`) ? t(`problems.${code}`) : t("problems.generic");
  };
}
