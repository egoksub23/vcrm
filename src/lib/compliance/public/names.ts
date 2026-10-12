// ============================================================
// Compliance requests, the public forms: comparing two names. Pure; browser-safe (the form uses it to say "an authorization letter is needed" as soon as
// the bank account holder name differs; the server decides again, because the browser's answer is only a convenience).
//
// The question is "is the bank account holder the same person as the Vircle account holder?". The answer is NO unless the names agree once the things
// that vary for no reason are set aside: upper and lower case, spaces, punctuation, accents, titles (Encik, Puan, Dato', Dr ...), the words that join a
// Malaysian name to the father's (bin, binti, bt, a/l ...), the spellings of Muhammad, and the order of the words (Tan Wei Ming / Wei Ming Tan). A
// name that merely CONTAINS the other, or has an extra word, is a different name: the letter is then asked for, which costs the customer a minute and
// never lets money go to the wrong person.
// ============================================================

/** Said before the name: removed from the start of the name only (so "Tan" in "Tan Wei Ming" is never taken for a title). */
const LEADING_TITLES = new Set([
  "mr", "mrs", "ms", "miss", "mdm", "madam", "dr", "prof", "ir", "ts", "sir", "tun", "toh",
  "encik", "en", "puan", "pn", "cik", "tuan", "tn", "dato", "datuk", "datin", "haji", "hajjah", "hj", "hjh", "tan sri", "puan sri",
]);

/** Words that join a person's name to a parent's: dropped wherever they stand. */
const CONNECTORS = new Set(["bin", "binti", "bte", "bt", "b", "anak", "ak", "abd"]);

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
  // "a/l", "a/p", "s/o", "d/o" (son / daughter of) are connectors too
  s = s.replace(/\b(a\/l|a\/p|s\/o|d\/o)\b/g, " bin ");
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
