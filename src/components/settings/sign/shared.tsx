"use client";

// Small pieces the Doc Sign settings screens share: a labelled field, a native select, a loading block, and
// the words for a failed call.

import { useCallback, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { Label } from "@/components/ui/label";
import { SignApiError } from "@/lib/sign/client/api";
import { adminErrorKey } from "@/lib/sign/client/admin-errors";
import { cn } from "@/lib/utils";

/** The sentence for a failed call, in the reader's language. */
export function useAdminErrorText(): (err: unknown) => string {
  const t = useTranslations("Sign.admin");
  return useCallback((err: unknown) => t(adminErrorKey(err instanceof SignApiError ? err.code : null)), [t]);
}

export function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function NativeSelect({
  id,
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cn(SELECT_CLASS, className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
