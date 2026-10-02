// ============================================================
// Languages the app offers, and how one is chosen for a request.
//
// A language is offered once it has a message file in /messages that is held to
// parity with English by src/i18n/messages.test.ts. (es and pt are frozen,
// partial dictionaries and are deliberately not offered.) Adding a language:
// add the file, add its code here and to TRANSLATED_LOCALES in the parity test.
//
// Choice, most specific first: the person's own setting, the workspace's
// setting, the deployment's default (NEXT_PUBLIC_APP_LOCALE), then English.
// Pure, so it is shared by the server (request-time resolution) and the
// settings screens.
// ============================================================

export const SUPPORTED_LOCALES = ["en", "ko"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Each language written in itself, so a person can find theirs whatever the current language. */
export const LOCALE_NAMES: Record<SupportedLocale, string> = {
  en: "English",
  ko: "한국어",
};

/** A supported code for `value` (case-insensitive, "ko-KR" and "ko_KR" count as "ko"), or null. */
export function normalizeLocale(value: string | null | undefined): SupportedLocale | null {
  if (!value) return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(base) ? (base as SupportedLocale) : null;
}

export function resolveLocale(choice: {
  user?: string | null;
  account?: string | null;
  deployment?: string | null;
}): SupportedLocale {
  return normalizeLocale(choice.user) ?? normalizeLocale(choice.account) ?? normalizeLocale(choice.deployment) ?? "en";
}

type Tree = { [key: string]: unknown };

function isTree(v: unknown): v is Tree {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `base` with every value `over` provides laid on top, nested objects merged.
 * Used to put a translation over English so a key not translated yet shows the
 * English text instead of a raw key path.
 */
export function mergeMessages<T extends Tree>(base: T, over: Tree): T {
  const out: Tree = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isTree(current) && isTree(value) ? mergeMessages(current, value) : value;
  }
  return out as T;
}
