import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";

import { FORM_ERROR_CODES, PROBLEM_CODES } from "@/lib/sign/client/signer-form";

import { readSignerFormMessages, SIGNER_LOCALES } from "./signer-test-messages";

// The form in parts words everything through next-intl (`Sign.signerForm`) in the signer's own language. This
// holds the translations to what the code asks for: every key the code uses exists, in all four languages, with
// the same placeholders, and no key is left that nothing asks for.

const messages = readSignerFormMessages();
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

const signerDir = join(process.cwd(), "src", "components", "sign", "signer");

/**
 * Keys asked for by name. In the form/ folder the translator is `t` (it is Sign.signerForm there; `ts` is Sign.signer);
 * in the page's own files, which use both, the form's translator is `tf`.
 */
function staticKeys(): string[] {
  const keys = new Set<string>();
  const formFiles = sources(join(signerDir, "form"));
  const pageFiles = sources(signerDir).filter((f) => !formFiles.includes(f));
  for (const file of formFiles) for (const m of readFileSync(file, "utf8").matchAll(/\bt(?:\.has)?\(\s*"([^"$]+)"/g)) keys.add(m[1]);
  for (const file of pageFiles) for (const m of readFileSync(file, "utf8").matchAll(/\btf(?:\.has)?\(\s*"([^"$]+)"/g)) keys.add(m[1]);
  return [...keys];
}

/** The families asked for with a variable. Each value the variable can take. */
const FAMILIES: Record<string, readonly string[]> = {
  status: ["not_started", "in_progress", "done", "needs_change"],
  problems: PROBLEM_CODES,
  format: ["digits", "letters", "alnum", "upper_alnum", "postcode_my"],
  image: ["pictureTooBig", "pictureUnreadable"],
  notice: ["missing_required", "invalid_answers", "answer_does_not_fit"],
  errors: FORM_ERROR_CODES,
};

const familyKeys = () => Object.entries(FAMILIES).flatMap(([family, names]) => names.map((n) => `${family}.${n}`));

run("Sign.signerForm messages", () => {
  const en = messages ? leaves(messages.en) : new Map<string, string>();

  it("has every key the code asks for", () => {
    const missing = staticKeys().filter((k) => !en.has(k));
    expect(missing).toEqual([]);
    expect(staticKeys().length).toBeGreaterThan(60);
  });

  it("has every key of the families the code builds", () => {
    expect(familyKeys().filter((k) => !en.has(k))).toEqual([]);
  });

  it("has no key that nothing asks for (a leftover to remove)", () => {
    const used = new Set([...staticKeys(), ...familyKeys()]);
    expect([...en.keys()].filter((k) => !used.has(k))).toEqual([]);
  });

  for (const locale of SIGNER_LOCALES.filter((l) => l !== "en")) {
    it(`${locale} has the same keys and placeholders as English, and every message formats`, () => {
      const other = leaves(messages![locale]);
      expect([...other.keys()].sort()).toEqual([...en.keys()].sort());
      const translator = (m: Tree, loc: string) => createTranslator({ locale: loc, messages: m as never, namespace: undefined, onError: () => {} }) as unknown as (k: string, v: object) => string;
      const values = { count: 2, done: 1, total: 3, percent: 40, part: "Bank", number: 2, label: "Legal name", max: 5, name: "Ali", detail: "5", types: "PDF, JPG", mb: 5, when: "2 minutes ago", item: "Bank", query: "bank", shown: 5 };
      const asEn = translator(messages!.en, "en");
      const asOther = translator(messages![locale], locale);
      for (const key of en.keys()) {
        const a = asEn(key, values);
        const b = asOther(key, values);
        expect(a, key).not.toContain(key);
        expect(b, `${locale} ${key}`).not.toContain(key);
        expect(/\{|\}/.test(b), `${locale} ${key} leaves a brace`).toBe(false);
        expect(b.trim().length, `${locale} ${key} is empty`).toBeGreaterThan(0);
      }
    });
  }
});
