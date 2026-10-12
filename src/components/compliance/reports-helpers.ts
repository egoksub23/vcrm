// ============================================================
// Compliance reports, the page's pure helpers (no React, no DOM, no network): the date presets, the percentages, the number formats.
// ============================================================

export const PRESETS = ["last30", "last90", "thisYear", "all", "custom"] as const;
export type Preset = (typeof PRESETS)[number];

const pad = (n: number) => String(n).padStart(2, "0");

/** A local calendar day as yyyy-mm-dd. */
export const dayString = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The days a preset stands for, in the browser's local days ("" means no limit). The last day is today. */
export function presetRange(preset: Preset, today: Date): { from: string; to: string } {
  switch (preset) {
    case "last30":
    case "last90": {
      const back = preset === "last30" ? 29 : 89;
      const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
      return { from: dayString(from), to: dayString(today) };
    }
    case "thisYear":
      return { from: `${today.getFullYear()}-01-01`, to: dayString(today) };
    case "all":
    default:
      return { from: "", to: "" };
  }
}

/** Is the range a valid one (each end empty or a real day, the start not after the end)? */
export function rangeValid(from: string, to: string): boolean {
  const ok = (v: string) => v === "" || (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)));
  return ok(from) && ok(to) && (from === "" || to === "" || from <= to);
}

/** A share as a whole percentage ("0" for an empty total). */
export const percent = (n: number, total: number): number => (total <= 0 ? 0 : Math.round((n / total) * 100));

/** Days with one decimal in the person's language, or a dash when there is nothing to show. */
export function days(n: number | null | undefined, locale: string): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  try {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}
