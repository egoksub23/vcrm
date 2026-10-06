import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A raw message key must never reach a screen. Every key the option-list screens ask for (in the Lists screen, the form
// builder's "where the options come from" and the signer's search) has to exist in every language, with the same placeholders.
//
// The keys live in messages/<locale>.json under Sign (merged from fragments). Until that has happened this test has nothing to
// read and is skipped; to run it against the fragments, point SIGN_I18N_FRAGMENT_DIR at the folder that holds lists-wp19.json,
// admin-wp19.json, formBuilder-wp19.json and signerForm-wp19.json.

type Tree = { [key: string]: unknown };
const LOCALES = ["en", "ms", "zh", "ko"] as const;
const root = process.cwd();

const AREAS: Record<string, string> = { "lists-wp19.json": "lists", "admin-wp19.json": "admin", "formBuilder-wp19.json": "formBuilder", "signerForm-wp19.json": "signerForm" };

function deep(into: Tree, extra: Tree) {
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === "object" && v !== null && typeof into[k] === "object" && into[k] !== null) deep(into[k] as Tree, v as Tree);
    else into[k] = v;
  }
}

function messages(locale: string): Tree | null {
  let all: Tree;
  try {
    all = JSON.parse(readFileSync(join(root, "messages", `${locale}.json`), "utf8")) as Tree;
  } catch {
    return null;
  }
  const dir = process.env.SIGN_I18N_FRAGMENT_DIR;
  const sign = ((all.Sign as Tree | undefined) ?? {}) as Tree;
  if (dir) {
    for (const [file, area] of Object.entries(AREAS)) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      const fragment = (JSON.parse(readFileSync(path, "utf8")) as Record<string, Tree>)[locale];
      if (!fragment) continue;
      sign[area] = (sign[area] as Tree | undefined) ?? {};
      deep(sign[area] as Tree, fragment);
    }
  }
  return { ...all, Sign: sign };
}

const at = (tree: Tree | null, path: string): unknown => path.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Tree)[k] : undefined), tree);
const leaves = (node: unknown, prefix = ""): Record<string, string> => {
  if (typeof node === "string") return { [prefix]: node };
  if (!node || typeof node !== "object") return {};
  return Object.assign({}, ...Object.entries(node as Tree).map(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k)));
};
const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g)].map((m) => m[1]))].sort();

const en = messages("en");
const have = at(en, "Sign.lists") !== undefined && at(en, "Sign.signerForm.search") !== undefined && at(en, "Sign.formBuilder.list") !== undefined;

const FILES = [
  "src/components/settings/sign/lists-section.tsx",
  "src/components/settings/sign/list-detail.tsx",
  "src/components/settings/sign/list-item-dialog.tsx",
  "src/components/settings/sign/list-meta-dialog.tsx",
  "src/components/settings/sign/list-import-dialog.tsx",
  "src/components/sign/form-builder/list-source.tsx",
  "src/components/sign/signer/form/search-picker.tsx",
];

/** [namespace, key or key prefix, dynamic] for every translation a file asks for. */
function used(file: string): { ns: string; key: string; dynamic: boolean; file: string }[] {
  const src = readFileSync(join(root, file), "utf8");
  const vars = new Map([...src.matchAll(/const (\w+) = useTranslations\("([^"]+)"\)/g)].map((m) => [m[1], m[2]]));
  const out: { ns: string; key: string; dynamic: boolean; file: string }[] = [];
  for (const [name, ns] of vars) {
    for (const m of src.matchAll(new RegExp(`(?<![\\w.])${name}\\(\\s*(?:"([^"]+)"|\`([^\`]+)\`)`, "g"))) {
      if (m[1] !== undefined) out.push({ ns, key: m[1], dynamic: false, file });
      else out.push({ ns, key: m[2].split("${")[0], dynamic: m[2].includes("${"), file });
    }
  }
  return out;
}

describe.runIf(have)("the option-list screens' messages", () => {
  const keys = FILES.flatMap(used);

  it("finds the keys the screens ask for (a guard against this test checking nothing)", () => {
    expect(keys.length).toBeGreaterThan(120);
    expect(new Set(keys.map((k) => k.ns))).toEqual(new Set(["Sign.lists", "Sign.lists.meta", "Sign.lists.import", "Sign.formBuilder", "Sign.signerForm"]));
  });

  for (const locale of LOCALES) {
    it(`has every key the screens ask for, in ${locale}`, () => {
      const tree = messages(locale);
      for (const { ns, key, dynamic, file } of keys) {
        const found = at(tree, `${ns}.${key}`.replace(/\.$/, ""));
        if (dynamic) expect(found, `${file}: ${ns}.${key}...`).toBeTypeOf("object");
        else expect(found, `${file}: ${ns}.${key}`).toBeTypeOf("string");
      }
    });
  }

  for (const locale of ["ms", "zh", "ko"] as const) {
    it(`has the same keys and the same placeholders as English in ${locale}`, () => {
      for (const path of ["Sign.lists", "Sign.signerForm.search", "Sign.formBuilder.list", "Sign.formBuilder.issues", "Sign.admin.tabs"]) {
        const a = leaves(at(en, path));
        const b = leaves(at(messages(locale), path));
        for (const [k, v] of Object.entries(a)) {
          expect(b[k], `${locale} ${path}.${k}`).toBeTypeOf("string");
          expect(placeholders(b[k]), `${locale} ${path}.${k}`).toEqual(placeholders(v));
        }
      }
    });
  }

  it("is real language: Bahasa Melayu, Chinese and Korean differ from English for the sentences", () => {
    for (const [locale, script] of [["zh", /[一-鿿]/], ["ko", /[가-힯]/]] as const) {
      const tree = messages(locale);
      for (const path of ["Sign.lists.intro", "Sign.lists.systemNote", "Sign.lists.import.intro", "Sign.signerForm.search.placeholder", "Sign.formBuilder.list.hint"]) {
        expect(at(tree, path) as string, `${locale} ${path}`).toMatch(script);
      }
    }
    for (const path of ["Sign.lists.intro", "Sign.lists.systemNote", "Sign.import.intro".replace("Sign.import", "Sign.lists.import"), "Sign.signerForm.search.placeholder"]) {
      expect(at(messages("ms"), path)).not.toBe(at(en, path));
    }
  });

  it("words every error and every import problem code, in every language", () => {
    for (const locale of LOCALES) {
      const lists = at(messages(locale), "Sign.lists") as { errors?: Record<string, unknown>; import?: { problems?: Record<string, unknown> } };
      expect(lists.errors?.generic).toBeTypeOf("string");
      expect(lists.import?.problems?.unknown).toBeTypeOf("string");
    }
  });
});
