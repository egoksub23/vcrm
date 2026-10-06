// Doc Sign, the detail screen: dates, sizes and lists written for the reader's language and time zone. Pure.

/** A date and time in the viewer's own time zone (the browser's), in the reader's language. */
export function formatWhen(iso: string | null | undefined, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
  } catch {
    return d.toISOString();
  }
}

/** A date only. */
export function formatDay(iso: string | null | undefined, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** "340 kB", "1.2 MB". */
export function formatSize(bytes: number, locale: string): string {
  const kb = bytes / 1024;
  const mb = kb / 1024;
  try {
    if (mb >= 1) return new Intl.NumberFormat(locale, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(mb);
    return new Intl.NumberFormat(locale, { style: "unit", unit: "kilobyte", maximumFractionDigits: 0 }).format(Math.max(1, Math.round(kb)));
  } catch {
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} kB`;
  }
}

/** "Ali and Siti", or "Ali, Siti" when more names follow in the sentence. */
export function joinNames(names: readonly string[], locale: string, more: boolean): string {
  try {
    return new Intl.ListFormat(locale, more ? { type: "unit", style: "short" } : { type: "conjunction", style: "long" }).format(names);
  } catch {
    return names.join(", ");
  }
}
