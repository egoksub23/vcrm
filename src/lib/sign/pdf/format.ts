// ============================================================
// Formatting and text fitting for the PDF engine. Pure: no PDF library here, so the
// rules are cheap to test. Text width comes in as a function.
// ============================================================

export type EngineLocale = "en" | "ms" | "zh" | "ko";

const MONTHS: Record<EngineLocale, { long: string[]; short: string[] }> = {
  en: {
    long: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    short: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  },
  ms: {
    long: ["Januari", "Februari", "Mac", "April", "Mei", "Jun", "Julai", "Ogos", "September", "Oktober", "November", "Disember"],
    short: ["Jan", "Feb", "Mac", "Apr", "Mei", "Jun", "Jul", "Ogo", "Sep", "Okt", "Nov", "Dis"],
  },
  // Chinese and Korean write the month as a number; the tokens MMM and MMMM give "10月" and "10월".
  zh: {
    long: Array.from({ length: 12 }, (_, i) => `${i + 1}月`),
    short: Array.from({ length: 12 }, (_, i) => `${i + 1}月`),
  },
  ko: {
    long: Array.from({ length: 12 }, (_, i) => `${i + 1}월`),
    short: Array.from({ length: 12 }, (_, i) => `${i + 1}월`),
  },
};

export const DEFAULT_DATE_FORMAT = "DD MMM YYYY";

/** The calendar parts of an instant in a time zone. Falls back to UTC for an unknown zone. */
function partsIn(date: Date, timeZone: string): { year: number; month: number; day: number } {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

/** Format an instant with tokens DD, D, MM, M, MMMM, MMM, YYYY, YY. Anything else is kept as written. */
export function formatDate(date: Date, format: string = DEFAULT_DATE_FORMAT, locale: EngineLocale = "en", timeZone = "UTC"): string {
  const { year, month, day } = partsIn(date, timeZone);
  const names = MONTHS[locale] ?? MONTHS.en;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return format.replace(/YYYY|YY|MMMM|MMM|MM|M|DD|D/g, (tok) => {
    switch (tok) {
      case "YYYY":
        return pad(year, 4);
      case "YY":
        return pad(year % 100);
      case "MMMM":
        return names.long[month - 1];
      case "MMM":
        return names.short[month - 1];
      case "MM":
        return pad(month);
      case "M":
        return String(month);
      case "DD":
        return pad(day);
      default:
        return String(day);
    }
  });
}

/** An instant as "6 Oct 2026 14:03 UTC": date, 24-hour time and the zone it is shown in. */
export function formatDateTime(date: Date, timeZone = "UTC", locale: EngineLocale = "en"): string {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  // "GMT+8" -> "UTC+8"; the zone's own name is too long to sit beside a time
  const zone = tz === "UTC" ? "UTC" : String(parts.timeZoneName ?? "UTC").replace(/^GMT$/, "UTC").replace(/^GMT/, "UTC");
  return `${formatDate(date, DEFAULT_DATE_FORMAT, locale, tz)} ${parts.hour}:${parts.minute} ${zone}`;
}

/** A date typed or picked as YYYY-MM-DD, formatted. Anything that is not such a date is returned as it was. */
export function formatIsoDate(value: string, format: string = DEFAULT_DATE_FORMAT, locale: EngineLocale = "en"): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return value;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return value;
  return formatDate(d, format, locale, "UTC");
}

/** Format a number the way the document shows it: thousands separators, fixed decimals. */
export function formatNumber(value: string, decimals?: number): string {
  const cleaned = value.replace(/[,\s]/g, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return value;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return value;
  const d = typeof decimals === "number" && decimals >= 0 ? Math.min(decimals, 10) : undefined;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: d ?? 0,
    maximumFractionDigits: d ?? 10,
  });
}

/**
 * Break text into lines no wider than `maxWidth`, by words, and by characters inside a word that
 * is wider than a line. Newlines in the text are kept as line breaks.
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/(?<=\s)/)) {
      const trial = line + word;
      if (measure(trial.trimEnd()) <= maxWidth) {
        line = trial;
        continue;
      }
      if (line !== "") {
        out.push(line.trimEnd());
        line = "";
      }
      // a single word wider than the line: split it by characters
      let chunk = "";
      for (const ch of Array.from(word)) {
        if (measure(chunk + ch) > maxWidth && chunk !== "") {
          out.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
    }
    out.push(line.trimEnd());
  }
  return out;
}

export interface FittedText {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  /** The text did not fit even at the smallest size and was cut. */
  truncated: boolean;
}

export const MIN_FONT_SIZE = 5;
export const MAX_FONT_SIZE = 14;
const LINE_GAP = 1.2;

/**
 * Choose the largest font size (down to MIN_FONT_SIZE) at which `text` fits the box, wrapped when
 * `multiline`, on one line otherwise. A fixed size is honoured and never enlarged or shrunk.
 */
export function fitText(
  text: string,
  box: { w: number; h: number },
  measureAt: (size: number) => (s: string) => number,
  opts: { multiline?: boolean; fixedSize?: number; padding?: number } = {},
): FittedText {
  const pad = opts.padding ?? 2;
  const innerW = Math.max(box.w - pad * 2, 1);
  const innerH = Math.max(box.h - pad * 2, 1);
  const attempt = (size: number): FittedText | null => {
    const measure = measureAt(size);
    const lineHeight = size * LINE_GAP;
    if (!opts.multiline) {
      const single = text.replace(/\s*\n\s*/g, " ");
      if (lineHeight <= innerH + 0.01 && measure(single) <= innerW) {
        return { lines: [single], fontSize: size, lineHeight, truncated: false };
      }
      return null;
    }
    const lines = wrapText(text, innerW, measure);
    if (lines.length * lineHeight <= innerH + 0.01) {
      return { lines, fontSize: size, lineHeight, truncated: false };
    }
    return null;
  };

  if (opts.fixedSize) {
    return attempt(opts.fixedSize) ?? cut(text, innerW, innerH, measureAt(opts.fixedSize), opts.fixedSize, !!opts.multiline);
  }
  for (let size = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, innerH / LINE_GAP)); size >= MIN_FONT_SIZE; size -= 0.5) {
    const fit = attempt(size);
    if (fit) return fit;
  }
  return cut(text, innerW, innerH, measureAt(MIN_FONT_SIZE), MIN_FONT_SIZE, !!opts.multiline);
}

function cut(text: string, innerW: number, innerH: number, measure: (s: string) => number, size: number, multiline: boolean): FittedText {
  const lineHeight = size * LINE_GAP;
  if (!multiline) {
    let s = text.replace(/\s*\n\s*/g, " ");
    while (s.length > 1 && measure(s + "…") > innerW) s = s.slice(0, -1);
    return { lines: [s + "…"], fontSize: size, lineHeight, truncated: true };
  }
  const all = wrapText(text, innerW, measure);
  const fit = Math.max(1, Math.floor(innerH / lineHeight));
  const lines = all.slice(0, fit);
  if (lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*$/, "") + "…";
  return { lines, fontSize: size, lineHeight, truncated: true };
}
