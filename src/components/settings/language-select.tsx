"use client";

import { LOCALE_NAMES, SUPPORTED_LOCALES } from "@/lib/i18n/locales";

/**
 * A language picker. `value` is a language code, or "" for "no choice at this
 * level" (the person falls back to their workspace, the workspace to the
 * deployment default). Each language is written in itself so it can be found
 * whatever the current language is.
 */
export function LanguageSelect({
  id,
  value,
  onChange,
  defaultLabel,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  defaultLabel: string;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
    >
      <option value="">{defaultLabel}</option>
      {SUPPORTED_LOCALES.map((code) => (
        <option key={code} value={code}>
          {LOCALE_NAMES[code]}
        </option>
      ))}
    </select>
  );
}
