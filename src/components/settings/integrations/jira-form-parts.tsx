"use client";

// Small building blocks the Jira settings tabs share: a titled card, a switch
// row (label + one-line explanation + its default), and the native select
// styling the other settings screens use.

import { useId, type ReactNode } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export const selectClass =
  "h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

export function JiraCard({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-border bg-card p-4", className)}>
      {title ? <h3 className="text-sm font-semibold text-foreground">{title}</h3> : null}
      {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      <div className={title || description ? "mt-3" : undefined}>{children}</div>
    </div>
  );
}

export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
  defaultOn,
  warning,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** The out-of-the-box value, shown as "Default: on / off". */
  defaultOn?: boolean;
  warning?: string;
}) {
  const t = useTranslations("Settings.jira.common");
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground" id={id}>
          {label}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        {warning ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{warning}</span>
          </p>
        ) : null}
        {defaultOn !== undefined ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t(defaultOn ? "defaultOn" : "defaultOff")}
          </p>
        ) : null}
      </div>
      <Switch aria-labelledby={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/** A load failure inside a tab: the sentence and a Retry button. */
export function LoadProblem({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useTranslations("Settings.jira.common");
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm">
      <p className="min-w-0 flex-1 text-muted-foreground">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("retry")}
        </Button>
      ) : null}
    </div>
  );
}

export function LoadingLine({ label }: { label?: string }) {
  const t = useTranslations("Settings.jira.common");
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
      {label ?? t("loading")}
    </div>
  );
}
