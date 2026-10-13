// ============================================================
// Compliance requests, the public forms: comparing two names. Pure; browser-safe.
//
// The question the comparison answers is "does the bank account holder name look like the Vircle account holder name?". Since migration 186 it NEVER decides
// whether an authorization letter is needed (the parent says so by answering "Does this bank account belong to you?") and it never blocks a submission.
// It is only an INFORMATION FLAG for staff: when the parent says the account is their own but the two names still differ, the case shows a calm
// "check before paying" line. So a missed match costs a glance and a missed difference costs a check; neither can send money anywhere.
//
// The names agree once the things that vary for no reason are set aside: upper and lower case, spaces, punctuation, accents, titles and honorifics
// (Mr, Mrs, Ms, Mdm, Dr, Encik, Puan, Dato', Datuk, Datin, Tan Sri, Haji, Hajjah ...), the words that join a Malaysian name to the father's (bin, binti,
// bte, bt, b., anak, a/l, a/p, a.l., a.p., s/o, d/o, al, ap ...), the spellings of Muhammad, and the order of the words (Tan Wei Ming / Wei Ming Tan).
// A name that merely CONTAINS the other, or has an extra word, is a different name.
// ============================================================

/**
 * Said before the name: removed from the start of the name only (so "Tan" in "Tan Wei Ming" is never taken for a title). Two-word titles are listed
 * with their space ("tan sri").
 */
const LEADING_TITLES = new Set([
  "mr", "mrs", "ms", "miss", "mdm", "madam", "dr", "prof", "ir", "ts", "sir", "tun", "toh",
  "encik", "en", "puan", "pn", "cik", "tuan", "tn", "sdr", "sdri",
  "dato", "datuk", "datin", "haji", "hajjah", "hajah", "hj", "hjh",
  "tan sri", "puan sri", "toh puan", "dato sri", "dato seri", "datuk seri", "datuk sri", "datin seri", "datin sri",
]);

/** Words that join a person's name to a parent's, and the Arabic article: dropped wherever they stand. */
const CONNECTORS = new Set(["bin", "binti", "bte", "bt", "b", "anak", "ak", "abd", "ibn", "ibni", "al", "ap"]);

/** Spellings of the same name, brought to one. */
const SPELLINGS: Record<string, string> = {
  mohd: "muhammad",
  mohamed: "muhammad",
  mohammed: "muhammad",
  mohammad: "muhammad",
  muhamad: "muhammad",
  mohamad: "muhammad",
  muhd: "muhammad",
  md: "muhammad",
};

/** The words of a name in the form two names are compared in: lower case, no accents or punctuation, no titles, no connectors, spellings unified. */
export function nameWords(input: string | null | undefined): string[] {
  let s = (input ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // son / daughter of, in every way people type it: a/l a/p a.l. a.p. a / l  s/o d/o (a slash or a backslash; the dots only for the Tamil a.l. and a.p.)
  s = s.replace(/\ba\s*[/\\.]\s*[lp]\b\.?/g, " bin ").replace(/\b[sd]\s*[/\\]\s*o\b/g, " bin ");
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (s === "") return [];
  // two-word titles first, then one-word titles, both from the start only and as many as are stacked ("Dato Dr ...")
  let words = s.split(" ");
  for (;;) {
    const two = words.slice(0, 2).join(" ");
    if (words.length > 2 && LEADING_TITLES.has(two)) {
      words = words.slice(2);
      continue;
    }
    if (words.length > 1 && LEADING_TITLES.has(words[0])) {
      words = words.slice(1);
      continue;
    }
    break;
  }
  return words.filter((w) => !CONNECTORS.has(w)).map((w) => SPELLINGS[w] ?? w);
}

/** The key two names are compared by: the words, in order-free form. Empty when a name has no words. */
export function nameKey(input: string | null | undefined): string {
  return nameWords(input).sort().join(" ");
}

/** Are these the same name? An empty name matches nothing, not even another empty one. */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = nameKey(a);
  return ka !== "" && ka === nameKey(b);
}

/**
 * The staff flag "the bank holder name differs from the account holder name: check before paying". True only when the parent said the bank account is
 * their own AND the names do not agree once normalised. Nothing is flagged for a third-party account (a letter is on file instead), when the question
 * was not asked (a case from before the question, or one staff typed), or while either name is missing. Never given to the parent.
 */
export function holderNameDiffers(own: boolean | null | undefined, accountHolder: string | null | undefined, bankHolder: string | null | undefined): boolean {
  if (own !== true) return false;
  if (nameKey(accountHolder) === "" || nameKey(bankHolder) === "") return false;
  return !namesMatch(accountHolder, bankHolder);
}
