// Which language the coach's report page is shown in. English first; Malay and Chinese are ready (the form stores every label as a language map, and the page's
// own words are translated). A coach can switch with the links on the page; otherwise the phone's language setting decides.

export const REPORT_LANGS = ["en", "ms", "zh"] as const;
export type ReportLang = (typeof REPORT_LANGS)[number];

export const REPORT_LANG_NAMES: Record<ReportLang, string> = { en: "English", ms: "Bahasa Melayu", zh: "中文" };

const isLang = (v: unknown): v is ReportLang => typeof v === "string" && (REPORT_LANGS as readonly string[]).includes(v);

/** `ms-MY` -> `ms`, `zh-Hans-CN` -> `zh`, `id` (Indonesian, close enough for a Malay reader) -> `ms`. Anything else is not a language we have. */
function fromTag(tag: string): ReportLang | null {
  const base = tag.trim().toLowerCase().split("-")[0];
  if (base === "id" || base === "ms") return "ms";
  return isLang(base) ? base : null;
}

/** The language to use: an explicit `?lang=` wins, then the best match in the Accept-Language header (highest q first), else English. */
export function pickLang(param: string | null | undefined, acceptLanguage: string | null | undefined): ReportLang {
  if (isLang(param)) return param;
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = Number(params.find((p) => p.trim().startsWith("q="))?.split("=")[1] ?? "1");
      return { tag, q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranked) {
    const lang = fromTag(tag);
    if (lang) return lang;
  }
  return "en";
}
