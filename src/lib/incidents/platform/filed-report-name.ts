// The file name of a filed report (the PDF of a closed incident): incident number, type, and when the PDF was made, e.g.
// INC-2026-8-Injury-20261117-0852.pdf. The time is in the school's time zone. Pure, so the download route, the generator and the tests share it.

const plain = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** yyyymmdd-hhmm of `at` in `timeZone` (UTC when the zone is not valid). */
export function filedReportStamp(at: Date, timeZone: string): string {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(at)
        .map((p) => [p.type, p.value]),
    );
    return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
  } catch {
    return at.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  }
}

export function filedReportFileName(reference: string, typeName: string, madeAt: Date, timeZone: string): string {
  return `${plain(reference) || "incident"}-${plain(typeName) || "incident"}-${filedReportStamp(madeAt, timeZone)}.pdf`;
}
