import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";

import { readSignerMessages, SIGNER_LOCALES } from "./signer-test-messages";

// The signing page words everything through next-intl in the signer's own language. This holds the
// translations to what the code asks for: every key the code uses exists, in all four languages, with the
// same placeholders.

const messages = readSignerMessages();
const run = messages ? describe : describe.skip;

type Tree = { [key: string]: unknown };

function leaves(node: unknown, path = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Tree)) for (const [p, s] of leaves(v, path ? `${path}.${k}` : k)) out.set(p, s);
  } else out.set(path, String(node));
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

/** Keys asked for by name, `t("a.b")` and `t.has("a.b")`. */
function staticKeys(): string[] {
  const files = [...sources(join(process.cwd(), "src", "components", "sign", "signer")), ...sources(join(process.cwd(), "src", "app", "s"))];
  const keys = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(file, "utf8").matchAll(/\bt(?:\.has)?\(\s*"([^"$]+)"/g)) keys.add(m[1]);
  }
  return [...keys];
}

/** The families asked for with a variable: `t(`tap.${type}`)`. Each value the variable can take. */
const FAMILIES: Record<string, string[]> = {
  fieldTypes: ["signature", "initials", "name", "date_signed", "date", "text", "number", "static_text", "checkbox", "dropdown", "upload"],
  tap: ["signature", "initials", "text", "number", "date", "dropdown", "checkbox", "upload"],
  status: ["todo", "optional", "done", "invalid", "system"],
  save: ["saving", "saved", "offline", "error"],
  others: ["signed", "declined", "turn", "invited", "waiting", "done", "title"],
  "sheet.signature": ["drawFailed", "pictureTooBig", "pictureUnreadable"],
  "sheet.picture": ["pictureTooBig", "pictureUnreadable"],
  // every code the page words on purpose; anything else reads as the general sentence
  errors: [
    "generic",
    "network",
    "rate_limited",
    "code_wrong",
    "code_expired",
    "code_too_many_attempts",
    "code_no_code",
    "code_format",
    "code_rate_limited",
    "code_not_sent",
    "code_not_needed",
    "code_required",
    "link_not_found",
    "signer_not_open",
    "consent_required",
    "missing_required",
    "invalid_answers",
    "body_too_large",
    "session_unavailable",
  ],
  // every code checkAnswer can give, and the page's own
  problems: ["text_too_long", "not_a_number", "not_a_date", "not_an_option", "not_a_checkbox", "bad_image", "bad_typed_signature", "not_your_field", "missing_required", "generic"],
};

run("Sign.signer messages", () => {
  const en = messages ? leaves(messages.en) : new Map<string, string>();

  it("has every key the code asks for", () => {
    const missing = staticKeys().filter((k) => !en.has(k));
    expect(missing).toEqual([]);
    expect(staticKeys().length).toBeGreaterThan(80);
  });

  it("has every key of the families the code builds", () => {
    const missing = Object.entries(FAMILIES).flatMap(([family, names]) => names.map((n) => `${family}.${n}`)).filter((k) => !en.has(k));
    expect(missing).toEqual([]);
  });

  it("has no key that nothing asks for (a leftover to remove)", () => {
    const used = new Set([...staticKeys(), ...Object.entries(FAMILIES).flatMap(([family, names]) => names.map((n) => `${family}.${n}`))]);
    expect([...en.keys()].filter((k) => !used.has(k))).toEqual([]);
  });

  for (const locale of SIGNER_LOCALES.filter((l) => l !== "en")) {
    it(`${locale} has the same keys and placeholders as English`, () => {
      const other = leaves(messages![locale]);
      expect([...other.keys()].sort()).toEqual([...en.keys()].sort());
      for (const [key, english] of en) {
        const translator = (m: Tree, loc: string) => createTranslator({ locale: loc, messages: m as never, namespace: undefined, onError: () => {} });
        // the placeholders are the argument names in the message: each must work with the same values
        const values = { count: 2, done: 1, total: 3, page: 1, name: "Ali", workspace: "Kedai", product: "Halo", time: "0:42", to: "a***@x.test", reference: "R-1", date: "20 Oct 2026", value: "06 Oct 2026" };
        const asEn = translator(messages!.en, "en") as unknown as (k: string, v: object) => string;
        const asOther = translator(messages![locale], locale) as unknown as (k: string, v: object) => string;
        const a = asEn(key, values);
        const b = asOther(key, values);
        expect(a, key).not.toContain(key);
        expect(b, `${locale} ${key}`).not.toContain(key);
        expect(/\{|\}/.test(b), `${locale} ${key} leaves a brace`).toBe(false);
        expect(english.length).toBeGreaterThan(0);
      }
    });
  }
});
